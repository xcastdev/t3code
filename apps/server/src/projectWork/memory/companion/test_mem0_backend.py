"""Exercise the pinned native vector store without learned models or networking."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from mem0_backend import MAX_BYTES, dispatch, namespace_path, Scope


def reject_network(event, _):
    if event in ("socket.connect", "socket.getaddrinfo", "socket.sendto"):
        raise AssertionError("Native index tests must not use networking")


sys.addaudithook(reject_network)


class Mem0BackendTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def request(self, operation, **input):
        return {"protocolVersion": 1, "requestId": "test-effect", "operation": operation,
                "input": {"environmentId": "environment-a", "projectId": "project-a", **input}}

    def entry(self, observation_id="observation-a", **change):
        return {"observationId": observation_id, "body": "Retained source observation",
                "payloadHash": "a" * 64, "vector": [1.0] + [0.0] * 2047, **change}

    def index_input(self, **change):
        return {"sourceRecordId": "memory-source-a", "sourceRevision": 1,
                "sourceGeneration": 1, "extractionId": "extraction-a",
                "observations": [self.entry()], **change}

    def call(self, operation, **input):
        response = dispatch(self.root, self.request(operation, **input))
        self.assertEqual(response["requestId"], "test-effect")
        self.assertEqual(response["operation"], operation)
        self.assertNotIn("error", response, response)
        return response["result"]

    def test_native_index_reconcile_search_and_idempotent_replay(self):
        data = self.index_input()
        self.assertEqual(self.call("index", **data)["writtenObservationIds"], ["observation-a"])
        self.assertEqual(self.call("index", **data)["writtenObservationIds"], [])
        self.assertTrue(self.call("reconcile", **data)["complete"])
        result = self.call("search", vector=self.entry()["vector"], limit=10)
        self.assertEqual([hit["observationId"] for hit in result["candidates"]], ["observation-a"])
        self.assertNotIn("Retained source observation", json.dumps(result))

    def test_same_id_rejects_changed_body_vector_tuple_even_with_same_caller_hash(self):
        data = self.index_input()
        self.call("index", **data)
        for change in ({"body": "Changed wording"}, {"vector": [0.0, 1.0] + [0.0] * 2046},
                       {"vector": [1.0000000001] + [0.0] * 2047}):
            response = dispatch(self.root, self.request("index", **self.index_input(observations=[self.entry(**change)])))
            self.assertEqual(response["error"]["code"], "conflict")
        changed = {**data, "extractionId": "other-extraction"}
        self.assertEqual(dispatch(self.root, self.request("index", **changed))["error"]["code"], "conflict")
        self.assertTrue(self.call("reconcile", **data)["complete"])

    def test_namespaces_isolate_identical_observation_and_project_ids(self):
        data = self.index_input()
        self.call("index", **data)
        for scope in ({"environmentId": "environment-b"}, {"projectId": "project-b"}):
            result = self.call("search", vector=self.entry()["vector"], limit=10, **scope)
            self.assertEqual(result["candidates"], [])
            self.call("index", **data, **scope)
        self.call("delete-project")
        for scope in ({"environmentId": "environment-b"}, {"projectId": "project-b"}):
            self.assertTrue(self.call("reconcile", **data, **scope)["complete"])

    def test_reconcile_and_delete_scan_beyond_one_hundred_points(self):
        data = self.index_input(observations=[self.entry(f"observation-{i}") for i in range(130)])
        self.call("index", **data)
        self.assertTrue(self.call("reconcile", **data)["complete"])
        shorter = {**data, "observations": data["observations"][:100]}
        result = self.call("reconcile", **shorter)
        self.assertFalse(result["complete"])
        self.assertEqual(len(result["unexpectedBackendIds"]), 30)
        source = {key: data[key] for key in ("sourceRecordId", "sourceRevision", "sourceGeneration")}
        self.call("delete-source", **source)
        self.assertTrue(self.call("delete-source", **source)["cleanupComplete"])
        directory = namespace_path(self.root, Scope(environmentId="environment-a", projectId="project-a"))
        from mem0_backend import native_store, scan
        native = native_store(directory)
        try:
            self.assertEqual(list(scan(native, {})), [])
        finally:
            native.client.close()

    def crash(self, operation, checkpoint, **input):
        child = subprocess.run([sys.executable, __file__, "--crash", str(self.root), checkpoint],
                               input=json.dumps(self.request(operation, **input)), text=True,
                               capture_output=True, check=False)
        self.assertEqual(child.returncode, 75, child.stderr)

    def test_crash_partial_write_recovers_missing_original_handles(self):
        data = self.index_input(observations=[self.entry("first"), self.entry("second")])
        self.crash("index", "after-index-point", **data)
        result = self.call("reconcile", **data)
        self.assertFalse(result["complete"])
        self.assertEqual(result["missingObservationIds"], ["second"])
        self.assertEqual(self.call("index", **data)["writtenObservationIds"], ["second"])
        self.assertTrue(self.call("reconcile", **data)["complete"])

    def test_durable_source_delete_blocks_delayed_write_after_crash_and_retries(self):
        data = self.index_input()
        self.call("index", **data)
        source = {key: data[key] for key in ("sourceRecordId", "sourceRevision", "sourceGeneration")}
        self.crash("delete-source", "after-delete-fence", **source)
        self.assertEqual(dispatch(self.root, self.request("index", **data))["error"]["code"], "fenced")
        self.assertEqual(self.call("search", vector=self.entry()["vector"], limit=10)["candidates"], [])
        self.call("delete-source", **source)
        self.call("delete-source", **source)
        future = {**data, "sourceRevision": 2, "sourceGeneration": 2}
        self.assertEqual(dispatch(self.root, self.request("index", **future))["error"]["code"], "fenced")

    def test_project_delete_crash_mid_scan_is_idempotent(self):
        data = self.index_input(observations=[self.entry(f"id-{i}") for i in range(130)])
        self.call("index", **data)
        self.crash("delete-project", "after-delete-point")
        self.assertEqual(dispatch(self.root, self.request("index", **data))["error"]["code"], "fenced")
        self.call("delete-project")
        self.call("delete-project")
        self.assertEqual(dispatch(self.root, self.request("search", vector=self.entry()["vector"], limit=10))["error"]["code"], "fenced")

    def test_generation_crash_before_cleanup_never_replays_old_generation(self):
        old = self.index_input()
        self.call("index", **old)
        new = self.index_input(sourceRevision=2, sourceGeneration=2, extractionId="extraction-b",
                               observations=[self.entry("new-observation")])
        self.crash("index", "after-index-fence", **new)
        self.assertEqual(dispatch(self.root, self.request("index", **old))["error"]["code"], "fenced")
        self.assertEqual(self.call("search", vector=self.entry()["vector"], limit=10)["candidates"], [])
        self.call("index", **new)
        from mem0_backend import native_store, scan
        directory = namespace_path(self.root, Scope(environmentId="environment-a", projectId="project-a"))
        native = native_store(directory)
        try:
            self.assertEqual([point.payload["sourceGeneration"] for point in scan(native, {})], [2])
        finally:
            native.client.close()

    def test_missing_fence_after_empty_delete_and_malformed_fence_fail_closed(self):
        self.call("health")
        self.call("delete-project")
        directory = namespace_path(self.root, Scope(environmentId="environment-a", projectId="project-a"))
        fence = directory / "t3-index-fences.json"
        fence.unlink()
        for operation, data in (("health", {}), ("index", self.index_input())):
            self.assertEqual(dispatch(self.root, self.request(operation, **data))["error"]["code"], "unavailable")
        fence.write_text('{"version":1,"deleted":false}')
        self.assertEqual(dispatch(self.root, self.request("index", **self.index_input()))["error"]["code"], "unavailable")

    def test_rejects_forged_persisted_namespace_identity(self):
        self.call("health")
        directory = namespace_path(self.root, Scope(environmentId="environment-a", projectId="project-a"))
        path = directory / "t3-index-fences.json"
        fence = json.loads(path.read_text())
        fence["environmentId"] = "environment-b"
        path.write_text(json.dumps(fence))
        self.assertEqual(dispatch(self.root, self.request("health"))["error"]["code"], "unavailable")

    def test_initialization_fence_precedes_native_store_and_partial_directory_fails_closed(self):
        self.crash("health", "after-initialize-fence")
        directory = namespace_path(self.root, Scope(environmentId="environment-a", projectId="project-a"))
        self.assertTrue((directory / "t3-index-fences.json").is_file())
        self.assertFalse((directory / "points").exists())
        self.call("index", **self.index_input())
        other = namespace_path(self.root, Scope(environmentId="environment-b", projectId="project-a"))
        other.mkdir()
        self.assertEqual(dispatch(self.root, self.request("health", environmentId="environment-b"))["error"]["code"], "unavailable")

    def test_reconcile_detects_native_payload_vector_and_unexpected_handle_corruption(self):
        from mem0_backend import native_store, scan
        data = self.index_input()
        self.call("index", **data)
        directory = namespace_path(self.root, Scope(environmentId="environment-a", projectId="project-a"))
        store = native_store(directory)
        try:
            point = list(scan(store, {}))[0]
            store.update(str(point.id), vector=[0.0, 1.0] + [0.0] * 2046)
        finally:
            store.client.close()
        result = self.call("reconcile", **data)
        self.assertFalse(result["complete"])
        self.assertEqual(result["invalidObservationIds"], ["observation-a"])
        store = native_store(directory)
        try:
            store.update(str(point.id), vector=self.entry()["vector"], payload={**point.payload, "data": "Changed native wording"})
        finally:
            store.client.close()
        self.assertEqual(self.call("reconcile", **data)["invalidObservationIds"], ["observation-a"])

    def test_native_hybrid_collection_is_rejected_without_local_embedding(self):
        self.call("health")
        directory = namespace_path(self.root, Scope(environmentId="environment-a", projectId="project-a"))
        from qdrant_client import QdrantClient, models
        from mem0_backend import COLLECTION
        client = QdrantClient(path=str(directory / "points"))
        try:
            client.delete_collection(COLLECTION)
            client.create_collection(COLLECTION, vectors_config=models.VectorParams(size=2048, distance=models.Distance.COSINE),
                                     sparse_vectors_config={"bm25": models.SparseVectorParams()})
        finally:
            client.close()
        self.assertEqual(dispatch(self.root, self.request("index", **self.index_input()))["error"]["code"], "unavailable")

    def test_strict_invalid_input_never_initializes_store(self):
        request = self.request("index", **self.index_input())
        malformed = [dict(request, extra=True), dict(request, protocolVersion=True),
                     dict(request, input={**request["input"], "extra": True}),
                     self.request("index", **self.index_input(observations=[self.entry(vector=[0.0] * 2047)])),
                     self.request("index", **self.index_input(observations=[self.entry(vector=[True] * 2048)])),
                     self.request("index", **self.index_input(sourceGeneration=True)),
                     self.request("index", **self.index_input(observations=[self.entry()] * 257)),
                     self.request("index", **self.index_input(observations=[self.entry()] * 2)),
                     self.request("search", vector=[1e300] * 2048, limit=10)]
        for bad in malformed:
            self.assertEqual(dispatch(self.root, bad)["error"]["code"], "invalid-request")
        for raw in (b"x" * (MAX_BYTES + 1), b'{"protocolVersion":1,"protocolVersion":1}',
                    b'{"protocolVersion":1,"input":NaN}'):
            self.assertEqual(dispatch(self.root, raw)["error"]["code"], "invalid-request")
        self.assertFalse((self.root / "namespaces").exists())

    def test_lock_is_the_actual_cross_process_namespace_lock(self):
        import portalocker
        directory = namespace_path(self.root, Scope(environmentId="environment-a", projectId="project-a"))
        lock_path = self.root / "locks" / (directory.name + ".lock")
        lock_path.parent.mkdir(parents=True)
        code = "import portalocker,sys; lock=portalocker.Lock(sys.argv[1]); lock.acquire(); print('locked',flush=True); sys.stdin.readline(); lock.release()"
        with subprocess.Popen([sys.executable, "-c", code, str(lock_path)], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as holder:
            self.assertEqual(holder.stdout.readline(), "locked\n")
            original = portalocker.Lock
            def immediate(*args, **kwargs):
                return original(*args, **{**kwargs, "timeout": 0})
            try:
                with mock.patch.object(portalocker, "Lock", immediate):
                    response = dispatch(self.root, self.request("index", **self.index_input()))
                    self.assertEqual(response["error"]["code"], "unavailable")
                    self.assertTrue(self.call("health", environmentId="environment-b")["embeddingDimensions"] == 2048)
            finally:
                holder.communicate("release\n", timeout=10)
            self.assertEqual(holder.returncode, 0)
        self.call("index", **self.index_input())

    def test_failed_fence_commit_has_no_native_write(self):
        self.call("health")
        with mock.patch("mem0_backend.os.replace", side_effect=OSError("controlled durable commit failure")):
            self.assertEqual(dispatch(self.root, self.request("index", **self.index_input()))["error"]["code"], "unavailable")
        self.assertEqual(self.call("search", vector=self.entry()["vector"], limit=10)["candidates"], [])


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--crash":
        target = sys.argv[3]
        def checkpoint(name):
            if name == target:
                os._exit(75)
        dispatch(sys.argv[2], sys.stdin.buffer.read(MAX_BYTES + 1), checkpoint)
        raise AssertionError("Required crash checkpoint was not reached")
    unittest.main()
