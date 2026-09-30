"""Derived Mem0 index only. T3 owns extraction, provenance, authorization and receipts.

One invocation owns one namespace under its cross-process lock. Fences are flushed
before native effects; loss of a fence never reconstructs authority from points.
The caller supplies frozen vectors. This module never initializes model clients.
"""
import os

os.environ.update(MEM0_TELEMETRY="false", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")

import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import pathlib
import struct
import sys
import tempfile
import uuid
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, field_validator

MAX_BYTES = 16 * 1024 * 1024
MAX_POINTS = 256
DIMENSIONS = 2048
COLLECTION = "t3_memory_dense_v1"
TextId = Annotated[StrictStr, Field(min_length=1, max_length=256)]
Counter = Annotated[StrictInt, Field(ge=0, le=9007199254740991)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Scope(StrictModel):
    environmentId: TextId
    projectId: TextId


class TupleInput(Scope):
    sourceRecordId: TextId
    sourceRevision: Counter
    sourceGeneration: Counter
    extractionId: TextId


def validate_vector(value):
    if not isinstance(value, list) or len(value) != DIMENSIONS:
        raise ValueError("Vector dimensions")
    for number in value:
        if type(number) not in (int, float) or not math.isfinite(number):
            raise ValueError("Vector finite values")
        try:
            converted = struct.unpack("<f", struct.pack("<f", number))[0]
        except (OverflowError, struct.error):
            raise ValueError("Vector float32 range") from None
        if not math.isfinite(converted):
            raise ValueError("Vector float32 range")
    return value


class Observation(StrictModel):
    observationId: TextId
    body: Annotated[StrictStr, Field(min_length=1, max_length=8000)]
    payloadHash: Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")]
    vector: list[float]
    _vector = field_validator("vector", mode="before")(validate_vector)


class ManifestInput(TupleInput):
    observations: Annotated[list[Observation], Field(min_length=1, max_length=MAX_POINTS)]

    @field_validator("observations")
    @classmethod
    def unique_ids(cls, entries):
        if len({entry.observationId for entry in entries}) != len(entries):
            raise ValueError("Duplicate observations")
        return entries


class SearchInput(Scope):
    vector: list[float]
    limit: Annotated[StrictInt, Field(ge=1, le=100)]
    _vector = field_validator("vector", mode="before")(validate_vector)


class DeleteSourceInput(Scope):
    sourceRecordId: TextId
    sourceRevision: Counter
    sourceGeneration: Counter


class Envelope(StrictModel):
    protocolVersion: Literal[1]
    requestId: TextId
    operation: Literal["health", "index", "reconcile", "search", "delete-source", "delete-project"]
    input: dict

    @field_validator("protocolVersion", mode="before")
    @classmethod
    def integer_version(cls, value):
        if type(value) is not int:
            raise ValueError("Protocol version")
        return value


class SourceFence(StrictModel):
    generation: Counter
    sourceRevision: Counter
    deleted: StrictBool


class Fence(Scope):
    version: Literal[1]
    deleted: StrictBool
    sources: dict[TextId, SourceFence]


class BackendFailure(Exception):
    def __init__(self, code):
        self.code = code


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON field")
        result[key] = value
    return result


def decode_json(data):
    if len(data) > MAX_BYTES:
        raise ValueError("Byte limit")
    return json.loads(data.decode("utf-8"), object_pairs_hook=unique_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Finite JSON")))


def namespace_path(root, scope):
    return pathlib.Path(root) / "namespaces" / digest([scope.environmentId, scope.projectId])


def write_fence(path, fence):
    data = canonical(fence.model_dump()).encode("utf-8")
    if len(data) > MAX_BYTES:
        raise BackendFailure("unavailable")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".fence-", delete=False) as file:
            temporary = pathlib.Path(file.name)
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def sync_directory(path):
    directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def read_fence(path, scope):
    try:
        with path.open("rb") as file:
            fence = Fence.model_validate(decode_json(file.read(MAX_BYTES + 1)))
        if (fence.environmentId, fence.projectId) != (scope.environmentId, scope.projectId):
            raise ValueError("Namespace identity")
        return fence
    except (OSError, ValueError):
        raise BackendFailure("unavailable") from None


def dependencies():
    if (importlib.metadata.version("mem0ai"), importlib.metadata.version("qdrant-client")) != ("2.2.1", "1.19.1"):
        raise BackendFailure("unavailable")
    # A fresh Mem0 collection enables learned sparse embeddings. This companion
    # permits only the pre-created dense layout, and no optional local models.
    if importlib.util.find_spec("fastembed") or importlib.util.find_spec("spacy"):
        raise BackendFailure("unavailable")


def native_store(directory):
    from qdrant_client import QdrantClient, models
    from mem0.vector_stores.qdrant import Qdrant

    native_path = directory / "points"
    client = QdrantClient(path=str(native_path))
    try:
        if not client.collection_exists(COLLECTION):
            client.create_collection(COLLECTION, vectors_config=models.VectorParams(
                size=DIMENSIONS, distance=models.Distance.COSINE))
        info = client.get_collection(COLLECTION).config.params
        if (not isinstance(info.vectors, models.VectorParams) or info.vectors.size != DIMENSIONS
                or info.vectors.distance != models.Distance.COSINE or info.sparse_vectors):
            raise BackendFailure("unavailable")
    finally:
        client.close()
    store = Qdrant(collection_name=COLLECTION, embedding_model_dims=DIMENSIONS, path=str(native_path))
    if store._has_bm25_slot:
        store.client.close()
        raise BackendFailure("unavailable")
    return store


def scan(store, filters):
    from qdrant_client import models

    native_filter = models.Filter(must=[models.FieldCondition(key=key, match=models.MatchValue(value=value))
                                       for key, value in filters.items()])
    offset = None
    previous = set()
    while True:
        rows, next_offset = store.client.scroll(COLLECTION, scroll_filter=native_filter, offset=offset,
                                               limit=64, with_payload=True, with_vectors=True)
        yield from rows
        if next_offset is None:
            break
        if str(next_offset) in previous:
            raise BackendFailure("unavailable")
        previous.add(str(next_offset))
        offset = next_offset


def scoped(scope):
    return {"environmentId": scope.environmentId, "projectId": scope.projectId}


def point_id(scope, observation_id):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, canonical([scope.environmentId, scope.projectId, observation_id])))


def vector_hash(vector):
    return hashlib.sha256(struct.pack("<2048f", *vector)).hexdigest()


def point_payload(input, observation):
    fields = {**scoped(input), "sourceRecordId": input.sourceRecordId,
              "sourceRevision": input.sourceRevision, "sourceGeneration": input.sourceGeneration,
              "extractionId": input.extractionId, "observationId": observation.observationId,
              "payloadHash": observation.payloadHash, "data": observation.body,
              "inputVectorHash": digest(observation.vector),
              "vectorHash": vector_hash(observation.vector)}
    return {**fields, "fingerprint": digest(fields)}


def valid_point(point, expected):
    vector = point.vector
    if isinstance(vector, dict):
        vector = vector.get("") if set(vector) == {""} else None
    try:
        return point.payload == expected and vector_hash(validate_vector(vector)) == expected["vectorHash"]
    except (ValueError, TypeError):
        return False


def require_current(fence, input):
    old = fence.sources.get(input.sourceRecordId)
    if (fence.deleted or (old and (old.deleted or input.sourceGeneration < old.generation
            or input.sourceRevision < old.sourceRevision
            or (input.sourceGeneration == old.generation and input.sourceRevision != old.sourceRevision)))):
        raise BackendFailure("fenced")
    return old


def delete_points(store, filters, checkpoint):
    # Delete after enumerating each page; the next page uses a stable point-ID cursor.
    for point in scan(store, filters):
        store.delete(str(point.id))
        checkpoint("after-delete-point")


def execute(directory, fence_path, fence, store, operation, input, checkpoint):
    if operation == "health":
        return {"engine": "mem0", "engineVersion": "2.2.1", "qdrantVersion": "1.19.1",
                "embeddingDimensions": DIMENSIONS}
    if operation in ("delete-source", "delete-project"):
        filters = scoped(input)
        if operation == "delete-project":
            fence.deleted = True
            # The locked directory already identifies the owned namespace. Damaged
            # payload scope cannot exempt retained source text from physical cleanup.
            filters = {}
        else:
            old = fence.sources.get(input.sourceRecordId)
            fence.sources[input.sourceRecordId] = SourceFence(
                generation=max(input.sourceGeneration, old.generation if old else 0),
                sourceRevision=max(input.sourceRevision, old.sourceRevision if old else 0), deleted=True)
            filters["sourceRecordId"] = input.sourceRecordId
        write_fence(fence_path, fence)
        checkpoint("after-delete-fence")
        delete_points(store, filters, checkpoint)
        return {"cleanupComplete": True}
    if fence.deleted:
        raise BackendFailure("fenced")
    if operation == "search":
        candidates = []
        for point in store.search(query="", vectors=input.vector, top_k=input.limit, filters=scoped(input)):
            payload = point.payload or {}
            try:
                candidate = Candidate.model_validate({key: payload[key] for key in Candidate.model_fields if key != "score"}
                                                     | {"score": point.score})
            except (KeyError, ValueError):
                continue
            source = fence.sources.get(candidate.sourceRecordId)
            if (source and not source.deleted and candidate.sourceGeneration == source.generation
                    and candidate.sourceRevision == source.sourceRevision
                    and scoped(candidate) == scoped(input)):
                candidates.append(candidate.model_dump())
        return {"candidates": candidates}
    require_current(fence, input)
    expected = {point_id(input, observation.observationId): point_payload(input, observation)
                for observation in input.observations}
    if operation == "index":
        # Inspect all requested IDs before any write; arbitrary caller hashes cannot
        # replace the immutable tuple/body/vector fingerprint of an existing ID.
        found = store.client.retrieve(COLLECTION, ids=list(expected), with_payload=True, with_vectors=True)
        for point in found:
            if not valid_point(point, expected[str(point.id)]):
                raise BackendFailure("conflict")
        fence.sources[input.sourceRecordId] = SourceFence(generation=input.sourceGeneration,
                                                         sourceRevision=input.sourceRevision, deleted=False)
        write_fence(fence_path, fence)
        checkpoint("after-index-fence")
        # Retry cleanup even when the fence already advanced in a crashed request.
        for point in scan(store, {**scoped(input), "sourceRecordId": input.sourceRecordId}):
            if (point.payload or {}).get("sourceGeneration") != input.sourceGeneration:
                store.delete(str(point.id))
                checkpoint("after-delete-point")
        found_ids = {str(point.id) for point in found}
        written = []
        for observation in input.observations:
            native_id = point_id(input, observation.observationId)
            if native_id not in found_ids:
                store.insert(vectors=[observation.vector], payloads=[expected[native_id]], ids=[native_id])
                written.append(observation.observationId)
                checkpoint("after-index-point")
        return {"writtenObservationIds": written}
    missing, invalid, unexpected, seen = [], [], [], set()
    for point in scan(store, {**scoped(input), "sourceRecordId": input.sourceRecordId,
                             "sourceGeneration": input.sourceGeneration, "extractionId": input.extractionId}):
        native_id = str(point.id)
        seen.add(native_id)
        if native_id not in expected:
            unexpected.append(native_id)
        elif not valid_point(point, expected[native_id]):
            invalid.append(expected[native_id]["observationId"])
    missing = [payload["observationId"] for native_id, payload in expected.items() if native_id not in seen]
    return {"complete": not missing and not invalid and not unexpected,
            "missingObservationIds": missing, "invalidObservationIds": invalid,
            "unexpectedBackendIds": unexpected}


class Candidate(TupleInput):
    observationId: TextId
    score: float

    @field_validator("score")
    @classmethod
    def finite_score(cls, value):
        if not math.isfinite(value):
            raise ValueError("Finite score")
        return value


def dispatch(store_dir, request, checkpoint=lambda _: None):
    envelope = None
    try:
        # Direct callers have the same byte boundary as the single-envelope CLI.
        serialized = request if isinstance(request, bytes) else canonical(request).encode("utf-8")
        envelope = Envelope.model_validate(decode_json(serialized))
        input_schema = {"health": Scope, "index": ManifestInput, "reconcile": ManifestInput,
                        "search": SearchInput, "delete-source": DeleteSourceInput, "delete-project": Scope}
        input = input_schema[envelope.operation].model_validate(envelope.input)
        dependencies()
        import portalocker

        directory = namespace_path(store_dir, input)
        lock_directory = pathlib.Path(store_dir) / "locks"
        lock_directory.mkdir(parents=True, exist_ok=True)
        with portalocker.Lock(str(lock_directory / (directory.name + ".lock")), timeout=10):
            fence_path = directory / "t3-index-fences.json"
            if directory.exists():
                fence = read_fence(fence_path, input)
            else:
                directory.mkdir(parents=True)
                # Persist the initialized namespace marker itself. Losing only the
                # fence must remain distinguishable from a pristine namespace.
                sync_directory(directory.parent)
                sync_directory(pathlib.Path(store_dir))
                fence = Fence(**scoped(input), version=1, deleted=False, sources={})
                write_fence(fence_path, fence)
                checkpoint("after-initialize-fence")
            store = native_store(directory)
            try:
                result = execute(directory, fence_path, fence, store, envelope.operation, input, checkpoint)
            finally:
                store.client.close()
        response = {"protocolVersion": 1, "requestId": envelope.requestId,
                    "operation": envelope.operation, "result": result}
        if len(canonical(response).encode("utf-8")) > MAX_BYTES:
            raise BackendFailure("unavailable")
        return response
    except BackendFailure as failure:
        code = failure.code
    except (ValueError, TypeError, OverflowError, RecursionError):
        code = "invalid-request"
    except Exception:
        code = "unavailable"
    return {"protocolVersion": 1, "requestId": envelope.requestId if envelope else "invalid",
            "operation": envelope.operation if envelope else "health",
            "error": {"code": code, "message": "Memory index request failed"}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store-dir", required=True)
    args = parser.parse_args()
    response = dispatch(args.store_dir, sys.stdin.buffer.read(MAX_BYTES + 1))
    sys.stdout.write(canonical(response) + "\n")


if __name__ == "__main__":
    main()
