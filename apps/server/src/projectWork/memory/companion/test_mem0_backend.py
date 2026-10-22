"""Run with configured companion Python; native index I/O is replaced by an in-memory store."""
import importlib.util
import math
import struct
import pathlib
import tempfile
import types
import unittest

spec = importlib.util.spec_from_file_location("memory_backend", pathlib.Path(__file__).with_name("mem0_backend.py"))
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class Store:
    def __init__(self):
        self.points = {}
        self.client = self

    def retrieve(self, collection, ids, **kwargs):
        return [self.points[key] for key in ids if key in self.points]

    def insert(self, vectors, payloads, ids):
        for key, vector, payload in zip(ids, vectors, payloads):
            squared_norm = sum(number * number for number in vector)
            native_norm = struct.unpack("<f", struct.pack("<f", math.sqrt(squared_norm)))[0]
            normalized = [number / native_norm for number in vector] if native_norm > 2 ** -23 else vector
            native_vector = [struct.unpack("<f", struct.pack("<f", number))[0] for number in normalized]
            self.points[key] = types.SimpleNamespace(id=key, vector=native_vector, payload=payload)

    def delete(self, key):
        self.points.pop(key, None)

    def close(self):
        pass


class CompanionTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.stores = {}
        backend.DIMENSIONS = 3
        backend.dependencies = lambda: None
        backend.native_store = lambda directory: self.stores.setdefault(str(directory), Store())
        backend.scan = lambda store, filters: iter([
            point for point in list(store.points.values())
            if all(point.payload.get(key) == value for key, value in filters.items())
        ])
        self.scope = dict(environmentId="env", ownerKind="assistant", ownerId="owner", ownerRevision=0)
        self.source = dict(**self.scope, sourceRecordId="source", sourceRevision=1, sourceGeneration=1, contentHash="a" * 64)
        self.manifest = dict(**self.source, extractionId="extraction", observations=[dict(
            observationId="fact", body="Known fact", payloadHash="b" * 64, vector=[1.0, 2.0, 3.0])])

    def call(self, operation, value, checkpoint=lambda _: None):
        return backend.dispatch(self.root.name, dict(protocolVersion=1, requestId="operation", operation=operation, input=value), checkpoint)

    def test_late_write_cannot_restore_retracted_exact_source(self):
        self.assertIn("result", self.call("index", self.manifest))
        self.assertIn("result", self.call("delete-source", self.source))
        self.assertEqual(self.call("index", self.manifest)["error"]["code"], "fenced")
        self.assertEqual(sum(len(store.points) for store in self.stores.values()), 0)
        # A correction has a separate exact source fence, even with the same source ID.
        corrected = dict(self.manifest, sourceRevision=2, sourceGeneration=2, contentHash="c" * 64,
                         observations=[dict(self.manifest["observations"][0], observationId="corrected-fact")])
        self.assertIn("result", self.call("index", corrected))
        self.assertIn("result", self.call("delete-source", self.source))
        self.assertEqual(sum(len(store.points) for store in self.stores.values()), 1)

    def test_timeout_after_success_replays_original_manifest_and_cleanup(self):
        def fail_after_point(name):
            if name == "after-index-point":
                raise backend.BackendFailure("unavailable")
        self.assertIn("error", self.call("index", self.manifest, fail_after_point))
        self.assertIn("result", self.call("index", self.manifest))
        self.assertTrue(self.call("reconcile", self.manifest)["result"]["complete"])
        def fail_after_delete(name):
            if name == "after-delete-point":
                raise backend.BackendFailure("unavailable")
        self.assertIn("error", self.call("delete-source", self.source, fail_after_delete))
        self.assertTrue(self.call("delete-source", self.source)["result"]["cleanupComplete"])
        self.assertEqual(self.call("index", self.manifest)["error"]["code"], "fenced")

    def test_namespace_includes_environment_owner_kind_id_and_revision(self):
        scopes = [self.scope, dict(self.scope, environmentId="other"), dict(self.scope, ownerKind="project"),
                  dict(self.scope, ownerId="other"), dict(self.scope, ownerRevision=1)]
        for scope in scopes:
            self.assertIn("result", self.call("index", dict(self.manifest, **scope)))
        self.assertEqual(len(self.stores), len(scopes))

    def test_rejects_wrong_vector_dimensions_and_changed_retry_payload(self):
        malformed = dict(self.manifest, observations=[dict(self.manifest["observations"][0], vector=[1.0])])
        self.assertEqual(self.call("index", malformed)["error"]["code"], "invalid-request")
        self.assertIn("result", self.call("index", self.manifest))
        changed = dict(self.manifest, observations=[dict(self.manifest["observations"][0], body="changed")])
        self.assertEqual(self.call("index", changed)["error"]["code"], "conflict")

    def test_cosine_native_normalization_preserves_exact_retry_and_reconcile(self):
        self.assertIn("result", self.call("index", self.manifest))
        native = next(iter(next(iter(self.stores.values())).points.values())).vector
        self.assertNotEqual(native, self.manifest["observations"][0]["vector"])
        self.assertAlmostEqual(sum(number * number for number in native), 1.0, places=6)
        self.assertIn("result", self.call("index", self.manifest))
        self.assertTrue(self.call("reconcile", self.manifest)["result"]["complete"])

    def test_dimension_change_has_its_own_store_and_old_cleanup_remains_exact(self):
        self.assertIn("result", self.call("index", self.manifest))
        backend.DIMENSIONS = 2
        changed = dict(self.manifest, observations=[dict(self.manifest["observations"][0], vector=[4.0, 5.0])])
        self.assertIn("result", self.call("index", changed))
        self.assertEqual(len(self.stores), 2)
        backend.DIMENSIONS = 3
        self.assertIn("result", self.call("delete-source", self.source))
        backend.DIMENSIONS = 2
        self.assertTrue(self.call("reconcile", changed)["result"]["complete"])
        self.assertEqual(sum(len(store.points) for store in self.stores.values()), 1)

    def test_empty_facts_can_complete_without_a_native_vector_lookup(self):
        empty = dict(self.manifest, observations=[])
        self.assertIn("result", self.call("index", empty))
        self.assertTrue(self.call("reconcile", empty)["result"]["complete"])
        self.assertEqual(sum(len(store.points) for store in self.stores.values()), 0)

    def test_zero_tiny_epsilon_and_normal_vectors_reconcile_as_native_points(self):
        vectors = [[0.0, 0.0, 0.0], [1e-8, 0.0, 0.0], [2 ** -23, 0.0, 0.0],
                   [2 ** -22, 0.0, 0.0], [1.0, 2.0, 3.0]]
        for index, vector in enumerate(vectors):
            manifest = dict(self.manifest, sourceRecordId=f"source-{index}", extractionId=f"extraction-{index}",
                            observations=[dict(self.manifest["observations"][0], observationId=f"fact-{index}", vector=vector)])
            self.assertIn("result", self.call("index", manifest))
            self.assertTrue(self.call("reconcile", manifest)["result"]["complete"])
            self.assertIn("result", self.call("index", manifest))
        self.assertEqual(sum(len(store.points) for store in self.stores.values()), len(vectors))


if __name__ == "__main__":
    unittest.main()
