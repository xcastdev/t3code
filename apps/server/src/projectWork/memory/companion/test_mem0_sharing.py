"""Prepared-vector source filtering with a controlled store; no native engine or model."""
import pathlib
import sys
import unittest
from types import SimpleNamespace

from mem0_backend import Fence, SearchInput, execute


def reject_network(event, _):
    if event in ("socket.connect", "socket.getaddrinfo", "socket.sendto"):
        raise AssertionError("Sharing tests must not use networking")


sys.addaudithook(reject_network)


class ControlledStore:
    def __init__(self, candidates):
        self.candidates = candidates
        self.filters = None

    def search(self, **request):
        self.filters = request["filters"]
        return [SimpleNamespace(payload=candidate, score=1.0) for candidate in self.candidates]


class SharingFilterTest(unittest.TestCase):
    def test_exact_source_filters_and_rechecks_candidates(self):
        scope = {"environmentId": "environment", "projectId": "owner"}
        source = {"sourceRecordId": "selected", "sourceRevision": 3, "sourceGeneration": 4}
        candidate = {**scope, **source, "extractionId": "extraction", "observationId": "observation"}
        changes = [{}, {"projectId": "recipient"}, {"environmentId": "foreign"},
                   {"sourceRecordId": "other"}, {"sourceRevision": 2}, {"sourceGeneration": 3}]
        store = ControlledStore([{**candidate, **change} for change in changes])
        fence = Fence(**scope, version=1, deleted=False, sources={
            "selected": {"generation": 4, "sourceRevision": 3, "deleted": False},
            "other": {"generation": 4, "sourceRevision": 3, "deleted": False},
        })
        request = SearchInput(**scope, source=source, vector=[0.125] * 2048, limit=12)
        result = execute(pathlib.Path("/unused"), pathlib.Path("/unused"), fence, store,
                         "search", request, lambda _: self.fail("Search must not write"))
        self.assertEqual(store.filters, {**scope, **source})
        self.assertEqual(result, {"candidates": [{**candidate, "score": 1.0}]})

    def test_local_search_keeps_original_scope_and_omitted_selector(self):
        scope = {"environmentId": "environment", "projectId": "local"}
        request = SearchInput(**scope, vector=[0.125] * 2048, limit=12)
        store = ControlledStore([])
        fence = Fence(**scope, version=1, deleted=False, sources={})
        self.assertEqual(execute(pathlib.Path("/unused"), pathlib.Path("/unused"), fence, store,
                                 "search", request, lambda _: self.fail("Search must not write")),
                         {"candidates": []})
        self.assertEqual(store.filters, scope)


if __name__ == "__main__":
    unittest.main()
