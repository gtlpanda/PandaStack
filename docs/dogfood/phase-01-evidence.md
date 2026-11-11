# Phase 1 evidence snapshot

Reviewed data appendix; not executable configuration. Original source hashes and
measurement limitations are preserved below.

```json
{
  "schemaVersion": 1,
  "recordedAt": "2026-11-10T13:47:09.830709+00:00",
  "testedRevision": "518f8ef208fdf1ba9a6ac1facf236fd2015f4564",
  "hunt": {
    "hunted": true,
    "docsOnly": false,
    "key": "codex-phase1-run-records-423431",
    "head": "4c409ae789acc56bbec94b15d4db56850d9f3e21",
    "target": "518f8ef208fdf1ba9a6ac1facf236fd2015f4564",
    "disposition": "pass",
    "because": [],
    "exempt": [
      {
        "commit": "518f8ef208fdf1ba9a6ac1facf236fd2015f4564",
        "because": "docs only"
      }
    ],
    "nativeRunId": "20261110T130322Z-1794316934926",
    "baselineRevision": "18eabde206c5041e098102b939877c8e4c99fb85",
    "lensesCovered": 6,
    "newFindings": 0
  },
  "acceptance": {
    "passed": 253,
    "failed": 0,
    "focusedGroupsPassed": 22,
    "sources": [
      {
        "name": "pandastack-phase1-p114-expanded-all-acceptance.log",
        "sha256": "22bf4dc46afcedae0c2ea7e76c0bf2f5c637821b7b7d4b5f784bfa0dd7f21a81"
      },
      {
        "name": "pandastack-phase1-p114-expanded-focused.log",
        "sha256": "3c377f35bc0cc81a40c0b1e5c7ed3dd815ed91765b8ca23c46244606036adbac"
      }
    ]
  },
  "host": {
    "exitCode": 0,
    "completedAt": "2026-11-10T13:42:28Z",
    "logSha256": "ca9f4fe7dfaa458513dd1ea92c9628f4807f6c27df409a1b55f717bb5395eeca",
    "gateLogExcerpt": [
      "[2026-11-10T13:13:12Z] Codex host gate: PASS; committed P1-14",
      "[2026-11-10T13:22:14Z] review: done (success, 1 turns); log logs/20261110T130322Z-review-after-iter-01.jsonl",
      "[2026-11-10T13:35:25Z] done: 0 new finding(s) across 6 lens(es): 0 reproduced, 0 confirmed without a reproduction, 0 contested, 0 not reproduced, 0 pre-existing, 0 refuted; repair (fix): 0 verified, 0 proposed, 0 unresolved",
      "[2026-11-10T13:42:28Z] bug hunt: 0 verified fix(es) landed on codex/phase1-run-records; pass",
      "[2026-11-10T13:42:28Z] every feature passes. Done."
    ]
  },
  "smoke": {
    "status": "passed",
    "startedAt": "2026-11-10T13:45:24.919675Z",
    "runnerRevision": "518f8ef208fdf1ba9a6ac1facf236fd2015f4564",
    "records": 4,
    "events": 8,
    "rootInvocations": 2,
    "childSessions": 2,
    "overlapVerified": true,
    "cleanupFailures": [],
    "runs": [
      {
        "id": "40923aaf-aa79-407e-8b20-8ae97c420141",
        "revision": "dcd3c8021ca56087de166a7d7c5582f8ed22a587",
        "runnerRevision": "518f8ef208fdf1ba9a6ac1facf236fd2015f4564",
        "workflow": "session",
        "backend": "codex",
        "settings": {
          "model": "gpt-6-astra",
          "subagentModel": "gpt-6.1-sol",
          "advisorModel": "gpt-6-astra",
          "probeModel": "gpt-6-luna",
          "effort": "medium",
          "subagentEffort": null,
          "advisorEffort": "medium",
          "probeEffort": "high",
          "maxConcurrentSubagents": 8,
          "subagentModelForce": false,
          "sources": {
            "model": "runtime",
            "subagentModel": "runtime",
            "advisorModel": "runtime",
            "probeModel": "runtime",
            "effort": "runtime",
            "subagentEffort": "unknown",
            "advisorEffort": "runtime",
            "probeEffort": "default",
            "maxConcurrentSubagents": "runtime",
            "subagentModelForce": "runtime"
          }
        },
        "parentRunId": "5df9fbda-5426-4168-9159-b46aaf37237f",
        "startedAt": "2026-11-10T13:45:25.089Z",
        "schemaVersion": 1,
        "project": "beta"
      },
      {
        "id": "44f07de0-67a2-48b7-b881-8e1ce2e35ae1",
        "revision": "2acaf479d7f2ddd24546cf3abb52000985836ac7",
        "runnerRevision": "518f8ef208fdf1ba9a6ac1facf236fd2015f4564",
        "workflow": "autobuild",
        "backend": "codex",
        "settings": {
          "model": "gpt-6-astra",
          "subagentModel": "gpt-6.1-sol",
          "advisorModel": "gpt-6-astra",
          "probeModel": "gpt-6-luna",
          "effort": "medium",
          "subagentEffort": null,
          "advisorEffort": "medium",
          "probeEffort": "high",
          "maxConcurrentSubagents": 8,
          "subagentModelForce": false,
          "sources": {
            "model": "runtime",
            "subagentModel": "runtime",
            "advisorModel": "runtime",
            "probeModel": "runtime",
            "effort": "runtime",
            "subagentEffort": "unknown",
            "advisorEffort": "runtime",
            "probeEffort": "default",
            "maxConcurrentSubagents": "runtime",
            "subagentModelForce": "runtime"
          }
        },
        "parentRunId": null,
        "startedAt": "2026-11-10T13:45:24.986Z",
        "schemaVersion": 1,
        "project": "alpha"
      },
      {
        "id": "5df9fbda-5426-4168-9159-b46aaf37237f",
        "revision": "dcd3c8021ca56087de166a7d7c5582f8ed22a587",
        "runnerRevision": "518f8ef208fdf1ba9a6ac1facf236fd2015f4564",
        "workflow": "autobuild",
        "backend": "codex",
        "settings": {
          "model": "gpt-6-astra",
          "subagentModel": "gpt-6.1-sol",
          "advisorModel": "gpt-6-astra",
          "probeModel": "gpt-6-luna",
          "effort": "medium",
          "subagentEffort": null,
          "advisorEffort": "medium",
          "probeEffort": "high",
          "maxConcurrentSubagents": 8,
          "subagentModelForce": false,
          "sources": {
            "model": "runtime",
            "subagentModel": "runtime",
            "advisorModel": "runtime",
            "probeModel": "runtime",
            "effort": "runtime",
            "subagentEffort": "unknown",
            "advisorEffort": "runtime",
            "probeEffort": "default",
            "maxConcurrentSubagents": "runtime",
            "subagentModelForce": "runtime"
          }
        },
        "parentRunId": null,
        "startedAt": "2026-11-10T13:45:24.990Z",
        "schemaVersion": 1,
        "project": "beta"
      },
      {
        "id": "8550671f-daaa-442d-93a3-84ce5c99d86c",
        "revision": "2acaf479d7f2ddd24546cf3abb52000985836ac7",
        "runnerRevision": "518f8ef208fdf1ba9a6ac1facf236fd2015f4564",
        "workflow": "session",
        "backend": "codex",
        "settings": {
          "model": "gpt-6-astra",
          "subagentModel": "gpt-6.1-sol",
          "advisorModel": "gpt-6-astra",
          "probeModel": "gpt-6-luna",
          "effort": "medium",
          "subagentEffort": null,
          "advisorEffort": "medium",
          "probeEffort": "high",
          "maxConcurrentSubagents": 8,
          "subagentModelForce": false,
          "sources": {
            "model": "runtime",
            "subagentModel": "runtime",
            "advisorModel": "runtime",
            "probeModel": "runtime",
            "effort": "runtime",
            "subagentEffort": "unknown",
            "advisorEffort": "runtime",
            "probeEffort": "default",
            "maxConcurrentSubagents": "runtime",
            "subagentModelForce": "runtime"
          }
        },
        "parentRunId": "44f07de0-67a2-48b7-b881-8e1ce2e35ae1",
        "startedAt": "2026-11-10T13:45:25.085Z",
        "schemaVersion": 1,
        "project": "alpha"
      }
    ],
    "eventsEvidence": [
      {
        "schemaVersion": 1,
        "id": "5d2b9482-5cca-4ea7-8deb-d45c032b7d7c",
        "runId": "40923aaf-aa79-407e-8b20-8ae97c420141",
        "type": "started",
        "at": "2026-11-10T13:45:25.121Z",
        "exitCode": null
      },
      {
        "schemaVersion": 1,
        "id": "eda3432a-3bb5-42e8-b927-1fd2d5edb2e8",
        "runId": "40923aaf-aa79-407e-8b20-8ae97c420141",
        "type": "finished",
        "at": "2026-11-10T13:45:50.803Z",
        "exitCode": 0
      },
      {
        "schemaVersion": 1,
        "id": "2aa1260e-bab6-4957-ad3b-85f85dd244b5",
        "runId": "44f07de0-67a2-48b7-b881-8e1ce2e35ae1",
        "type": "started",
        "at": "2026-11-10T13:45:25.009Z",
        "exitCode": null
      },
      {
        "schemaVersion": 1,
        "id": "e532fa4d-edad-40b9-b181-e40116b2314b",
        "runId": "44f07de0-67a2-48b7-b881-8e1ce2e35ae1",
        "type": "finished",
        "at": "2026-11-10T13:45:49.981Z",
        "exitCode": 0
      },
      {
        "schemaVersion": 1,
        "id": "c1f30d3d-50c5-46ae-96c5-ea17b4d3b7ae",
        "runId": "5df9fbda-5426-4168-9159-b46aaf37237f",
        "type": "started",
        "at": "2026-11-10T13:45:25.009Z",
        "exitCode": null
      },
      {
        "schemaVersion": 1,
        "id": "b554d15b-5299-49d1-bfdb-5efc3060d157",
        "runId": "5df9fbda-5426-4168-9159-b46aaf37237f",
        "type": "finished",
        "at": "2026-11-10T13:45:51.002Z",
        "exitCode": 0
      },
      {
        "schemaVersion": 1,
        "id": "d38803dc-bdd6-4a0e-a7fe-190d3579f02e",
        "runId": "8550671f-daaa-442d-93a3-84ce5c99d86c",
        "type": "started",
        "at": "2026-11-10T13:45:25.106Z",
        "exitCode": null
      },
      {
        "schemaVersion": 1,
        "id": "a9de7908-4a3d-4503-ba14-a6efa0a71c80",
        "runId": "8550671f-daaa-442d-93a3-84ce5c99d86c",
        "type": "finished",
        "at": "2026-11-10T13:45:49.690Z",
        "exitCode": 0
      }
    ],
    "finishedAt": "2026-11-10T13:45:51.205809Z",
    "projects": {
      "alpha": {
        "revision": "2acaf479d7f2ddd24546cf3abb52000985836ac7",
        "sourceRevision": "94067e17b1f4bd327597726177d7dbb7304a50e1",
        "initialHashes": {
          ".gitignore": "c66f8537345e4e0811ca69f1047f315a4f52c41077dc4c5c22622d7e72e6e490",
          "AGENTS.md": "ba41ba1b737da0d385d817e68b999428ba793cd4513adddae48729e98ba0dead",
          "PROGRESS.md": "4569d267c007b1d3108fdf8a4d241f0061eb77bf614e1a5f1504b96d5c0e1637",
          "SPEC.md": "bae9512535d648980324ab1b324752a39e1960cbe06fd2823e2ba35820560d76",
          "autobuild.json": "d6743ea9a379ba2ebc65f1b459bfa8d070f22d2121fccdc68fd5dd1a8f43f703",
          "features.json": "28c54aa61514b4af85e395af5c5bc6269932e806da429bdb71a2d95011b39f0b",
          "tests/smoke.test.mjs": "b324fa99d9aec5c656033e6543e24364f5156d8a32dc519e5ed6f7d9e3b074d9"
        },
        "completedRevision": "ed2fd905d2cb11d99ce792efa46e62a47c5d75b9"
      },
      "beta": {
        "revision": "dcd3c8021ca56087de166a7d7c5582f8ed22a587",
        "sourceRevision": "54a7e57abec453e87c2850303b33c020a184e6fa",
        "initialHashes": {
          ".gitignore": "c66f8537345e4e0811ca69f1047f315a4f52c41077dc4c5c22622d7e72e6e490",
          "AGENTS.md": "ba41ba1b737da0d385d817e68b999428ba793cd4513adddae48729e98ba0dead",
          "PROGRESS.md": "4569d267c007b1d3108fdf8a4d241f0061eb77bf614e1a5f1504b96d5c0e1637",
          "SPEC.md": "070a47d80b5b893a5f07187f4606f00551db94c569eb0f1c59d02a25f958ae77",
          "autobuild.json": "d6743ea9a379ba2ebc65f1b459bfa8d070f22d2121fccdc68fd5dd1a8f43f703",
          "features.json": "28c54aa61514b4af85e395af5c5bc6269932e806da429bdb71a2d95011b39f0b",
          "tests/smoke.test.mjs": "9916beaeacda9bdb7a8a9bc9be32a81a25bfecf1e0ee85cdaa7659e37b3f2368"
        },
        "completedRevision": "9710fe3ac86d9426edfda28aad650e45f19b236c"
      }
    }
  },
  "doctor": {
    "codex": {
      "exitCode": 2,
      "providerExecuted": false,
      "status": "degraded",
      "reportSha256": "91f5772d77bc7f4a28df177e05c431624d353a32ef0e05b78406e814159f8717"
    },
    "claude": {
      "exitCode": 2,
      "providerExecuted": false,
      "status": "degraded",
      "reportSha256": "0465ed4f4e2f1c18444ecd71642efa49971ef30041cdadad0dac534f6bb52e51"
    }
  },
  "usage": {
    "note": "Observed top-level completed-turn usage only, including interrupted-run stages. Failed/incomplete turns without usage remain unknown. Supervisor chat excluded. Cached input is a subset of input, not additional. No dollar estimate. Source file fingerprints bind this snapshot; run only after host stop for final evidence.",
    "totals": {
      "builders": {
        "completedTurns": 18,
        "knownSubtotals": {
          "input_tokens": 13335698,
          "cached_input_tokens": 12488320,
          "output_tokens": 109450,
          "reasoning_output_tokens": 11680
        },
        "missingMeasurements": {
          "input_tokens": 0,
          "cached_input_tokens": 0,
          "output_tokens": 0,
          "reasoning_output_tokens": 0
        }
      },
      "reviews": {
        "completedTurns": 11,
        "knownSubtotals": {
          "input_tokens": 8637396,
          "cached_input_tokens": 7941888,
          "output_tokens": 39778,
          "reasoning_output_tokens": 6862
        },
        "missingMeasurements": {
          "input_tokens": 0,
          "cached_input_tokens": 0,
          "output_tokens": 0,
          "reasoning_output_tokens": 0
        }
      },
      "hunts": {
        "completedTurns": 91,
        "knownSubtotals": {
          "input_tokens": 199122887,
          "cached_input_tokens": 183431808,
          "output_tokens": 443975,
          "reasoning_output_tokens": 169079
        },
        "missingMeasurements": {
          "input_tokens": 0,
          "cached_input_tokens": 0,
          "output_tokens": 0,
          "reasoning_output_tokens": 0
        }
      },
      "live-at-970953b": {
        "completedTurns": 2,
        "knownSubtotals": {
          "input_tokens": 175536,
          "cached_input_tokens": 154880,
          "output_tokens": 813,
          "reasoning_output_tokens": 0
        },
        "missingMeasurements": {
          "input_tokens": 0,
          "cached_input_tokens": 0,
          "output_tokens": 0,
          "reasoning_output_tokens": 0
        }
      },
      "historical-live": {
        "completedTurns": 3,
        "knownSubtotals": {
          "input_tokens": 309586,
          "cached_input_tokens": 267136,
          "output_tokens": 1362,
          "reasoning_output_tokens": 0
        },
        "missingMeasurements": {
          "input_tokens": 0,
          "cached_input_tokens": 0,
          "output_tokens": 0,
          "reasoning_output_tokens": 0
        }
      },
      "promotion-live": {
        "completedTurns": 2,
        "knownSubtotals": {
          "input_tokens": 175735,
          "cached_input_tokens": 145152,
          "output_tokens": 895,
          "reasoning_output_tokens": 0
        },
        "missingMeasurements": {
          "input_tokens": 0,
          "cached_input_tokens": 0,
          "output_tokens": 0,
          "reasoning_output_tokens": 0
        }
      }
    },
    "sourceFileCount": 154,
    "completedTurns": 127,
    "sourceHashes": [
      {
        "group": "builders",
        "sha256": "478bf061e83e3c9f4354a2d425b1b58bcaf2fdd656abfb63a690f895b4bc2865",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "builders",
        "sha256": "e5219914e2118b3f7731ec5ddd0345ba6636018ecfa7ff36130f5b8f75f55647",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "builders",
        "sha256": "320880db97d03fc2e957200276cf709553d207cf3b86aeef6f23158e7c19282f",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "builders",
        "sha256": "54235bd20b8b36f54c37646375011d87f62baf06a939464bd4892782e7132243",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "reviews",
        "sha256": "3dc5bb31399e0ad4ffeeedc5364c92fe5992b57e30dbc1e66c630fa933e8cd8f",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "builders",
        "sha256": "b8e4423ff74b4ef6814f9f9a17a71bc13d662361e7b5e9edec43088a12679fb7",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "reviews",
        "sha256": "fe71a608c0b1f4e42cdb297f20342c6d6b2e442385d66b9b3364c61f0f5434c2",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "builders",
        "sha256": "b9b186348dfbe6e0af4ace8d151c5fa8a44af80a1f5b972d76b420178823beba",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "reviews",
        "sha256": "e107cbb87b79e672cedd2a655d8884f363cb2138d363224876e66b78c283cc76",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "builders",
        "sha256": "0de9c22184b40016bbfbaaf1eeff27014cb5958e61a71308b547141f8652d954",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "reviews",
        "sha256": "5edd4fa87033982b51356e9d3f958c7366c97f9946f86e4f5fa5cada063cdaca",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "builders",
        "sha256": "e50e788ecf6b18fdbd9dd70ee57d29acf793962b6d0479e39071f44351edadc1",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "reviews",
        "sha256": "fc1e7f6f15fedf3b8bdb4942737206bc2aef6479b63fed1ca7101791088ea4b5",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "builders",
        "sha256": "56fb935b3b2c2de147ae2aa9339b8fa3f64833d5e165936c6bbe44e6f8273d36",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "builders",
        "sha256": "b46ac77f72db0d6ff4a443ca6fef458b0b9b2647391d2599bafb3dbfa4369997",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "builders",
        "sha256": "756fcd8e896380f9806e742f14f1086c5d1322752cda8f9e68ab8fca03142128",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "reviews",
        "sha256": "cf5fff7ac88c805582a1869e6ad45f1dde91bcc75864bab4fd94b9140ace8e58",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "builders",
        "sha256": "07358a95a0029b42b68ce46b7c02c270dffb9a0bfa71043880c08a8fa5912678",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "builders",
        "sha256": "ff05714d22c6d550e267d55a9db8b785926b3c75a445579117b61798ef20a2e0",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "reviews",
        "sha256": "619a17a572a383ec1696eec71513ed808bd8ff5b234ee084ffb131cde737007d",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "builders",
        "sha256": "bb87734b011505ce3b74093db62a74586a0a7e275ed650217880391275dd4ba9",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "reviews",
        "sha256": "dca653a9d1e1c67f69eff2ba10e5f9efa7b1dc45ab78fb760b62408436e061ca",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "builders",
        "sha256": "b8270224444539e5694ed8230a4693ebd04b8502b855844eb895f12b821946f5",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "reviews",
        "sha256": "4a1ad51b09453ae26a06fe0f5b7f5913f42349b59f839d38dead2ee70572dfb7",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "builders",
        "sha256": "6751f93a3f2a2d41685f93e35989cfdd3268907758f58b834a29efd64e369746",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "builders",
        "sha256": "656e3aa049dd4ca90e0aff91181574ed2121d1ff687229b4e1eca881c26e131f",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "reviews",
        "sha256": "3b3c3b89f52196d1b1e9310f28e63cd0e1f35faf4c253b1856af3d9b87c52414",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "builders",
        "sha256": "213defa2b9048b0928aec929d1e80b0f1eb6414502637766209cf1cd9949a29c",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "builders",
        "sha256": "73418575b27ae6b4740eb14bbe17cb082839860f522239d7d99a82d6ab988772",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "reviews",
        "sha256": "a35790bddfeacb99447c4860301ef3b0e2d58f8608a718d1c91b3df6bbf5195f",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "c05759cb5875ab49e1ea24c4a0e111591235b07b00364d363874a3c698169c6e",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "9b2573da79405279373fc809a621d4851578502ea54571e36d0aa68433608f70",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "f457c0450309786e37881fd23303daecc31188ac36b81052e3f1b689c2fb6d6d",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "2407fedcca47673d269d215585d5e60bbf20851b6b6f9e0d8fa8dd3bd7969854",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "4ccaa46dcf7e7d4090198411007214c8f7ea5d28fc043ffc944915056dec10a7",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "6c776a0ac9fb013ed7f8d94bcb3d819c6162080776a08db52455ecba6e5be843",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "b5d09007ac1c5d80b8863ff4b08eeaf57f0fc6b3292c36ef1ef7532d94bc0ecb",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "8ae70a78813d4efcabc8e670fa10c88bab800a3b072c0398be4252400197fa40",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "c875a2540f244989910220620dfed5e6f86fe63668b18b7878a1b1234a8977d5",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "d642aee52e4734ec4ad034fd295fd38ab16a151f26cff8f54f46de5756626aa0",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "bdac05acc035f301d6ee4cd4552d457e31aced4be571a0efa818ae652952f47f",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "c060e6e5617b38d43eac31836352cab0f055993eb88c6907f67862474b75de64",
        "completedTurns": 0,
        "errorEvents": 2,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "0ee0b7a8f0cc99f6938ffb72fde8e92c551dc8321a45965628b6639ff7ea55a1",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "d2041f38069c3102e8dbf05d56ea7ac84576a873de2c563a6f44d2a1f323144f",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "e2af95271384b0ab3fc40891121042db00a6c48622d1fb095f8fe409dfdf4eaa",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "510d63a80d42bb432b89fab2d6d3b0d716ab79e79c72869ca78ae0223bf8b876",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "032ae284e26b0d1d212379e08a1335f03e759b3ef58af126db7109115cb3bc7d",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "8b1ab1bcaddf92a7929cfb56134ae7e8233830b7330e04f6182fa29039531bcc",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "9183707761f52ddb374d2a10eaf52a07876f3521113435b834591ca31b4824e5",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "05ec17ee1c4c33a9454a4075b7c1d714315b05c569500d3227295109645ef6c0",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "e9bbd53c5bd33a707bc13bb31bef42c67a2d731ae92671d6ecabc465b8e10289",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "2f6b04d60a9f9f6d60026519a0d1699bc1e471af0813189d90fa82ebc847c640",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "bdd36ef26a07b474f4a9d5f004e88cef11f914c341bc9d7bd79d70884000d1a2",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "87bafb3a3bcf6965d2a363b0f71e9a62402c33816bb8c043400157b01b63cfb6",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 4
      },
      {
        "group": "hunts",
        "sha256": "5c90ebe1e28e52bfdb47bd9b67131df59fc003c925da5134d0fe600066420bb0",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 5
      },
      {
        "group": "hunts",
        "sha256": "eb64f5b4b3b6b1b79b3fb1e8d0a9f4d9169789e952fc15952b0cfb1ecadd16aa",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "c209a1649fbe61442ecd07d3a4b75ad39792c3c6a69d9e5b6759dc02f69e8fbb",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 2
      },
      {
        "group": "hunts",
        "sha256": "2e50ae5d30a4194803caa39fd8301c1d68309a8a55891eaf65a8cee948e940a8",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 2
      },
      {
        "group": "hunts",
        "sha256": "400eb897459558362c7895f20ff243b8b3929302af02deb1a2b19b3fd95a895c",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "c209a1649fbe61442ecd07d3a4b75ad39792c3c6a69d9e5b6759dc02f69e8fbb",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 2
      },
      {
        "group": "hunts",
        "sha256": "2e50ae5d30a4194803caa39fd8301c1d68309a8a55891eaf65a8cee948e940a8",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 2
      },
      {
        "group": "hunts",
        "sha256": "828f19d702318cb1f6351cb0206ed4771b091834b1475581e976e1371b68958b",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 3
      },
      {
        "group": "hunts",
        "sha256": "2c89637c7c545d13c421b96473ef3753906cd824aa80694553b4cb3353381ef5",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "8d324f18d21f04230de3967886b702279d3ab427986c914006d63e2877ee23a2",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "bb5b6ba777e67c1754c62327f204a6352369e10e7a2754d4f7880a2189265680",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "939c1851f44ffac432799992f1d06081edd80a068617f0ca4a3438b1eceb01d1",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "429f41804ddb4869f87dd7f0214909b5122e6e2f3c93e0741be108067f63b3f9",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "16eeedbc9a72dd257f4601ab90de84933d94af02a3310639e5247eca61628f3e",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "481f4c2ef31e5244321c32ef5f2939a6f3a7a565987edef7cd9bd88f3c1a04f7",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "20f25671cd2cf29a966ce46edc117845130ad23a4164c07604889cc6d067851e",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 1
      },
      {
        "group": "hunts",
        "sha256": "da31120bec30d62b7c2560c4879fc8ff4f7718ceb14843644b9cddc44d4a2521",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "33d1691ddd06745e9d52938e254455eb7cd8d261ba35c5710976b74e6c8ad8ce",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "4ed03ab9219be64daf0fd2ba569a671e6cac90870defe177554270118d2f44bd",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "d0dbf9c5a72ffd9f67aedf7d20925deff945f2be6df972db7630592bb3259546",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "4f91a0da088a9355b6b8e3b2934f4c76539fc06ee0477e68e3f4a1114c5c5e52",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "ef772118983d7b30d7fa14301ef9a02a301732cdf382b5aab9a1675db9d89cf5",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "9e61a4c9b5918375cb8df11c080c4ba315f28ee972e8bcb77a56b508914fde17",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "b5db5339ab539369302834956fb75a605416484f492e2962cce5a56e919627f8",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "3a1e90b9504d3d4b1b4b6407db66ef87067ba11110f7454a107e1b49eed2921b",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "9134763922bebb5c9d9af1174b22cca5089cc2f6e114acf2023ffd8001d12a6f",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "cc896baaf1320a49cc90ce9406b8a2beda7148f292e42406626912ae57ca30d5",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "4a81a14cf3f6dd1aad5498aedc8cb95d05f0e5e1e428617217562691972e304e",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 5
      },
      {
        "group": "hunts",
        "sha256": "a61c0179d00c1db81ab9eba85ff3e4c05ae741b80d71ac9d9167deed4dabd67b",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 5
      },
      {
        "group": "hunts",
        "sha256": "95b0b33af681f20ce13a9f21e28e189cdad3b0cf56ffabe72d86ceac0c9fc8b5",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "c209a1649fbe61442ecd07d3a4b75ad39792c3c6a69d9e5b6759dc02f69e8fbb",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 2
      },
      {
        "group": "hunts",
        "sha256": "795120131847135ec40aece68b30e2277cd5892e3af0d16ae75340345f441e97",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 2
      },
      {
        "group": "hunts",
        "sha256": "c540abe72651dd0542a717ffb85d1f71c47c3dd53b465239adc1269d2c31a8f7",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "c209a1649fbe61442ecd07d3a4b75ad39792c3c6a69d9e5b6759dc02f69e8fbb",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 2
      },
      {
        "group": "hunts",
        "sha256": "795120131847135ec40aece68b30e2277cd5892e3af0d16ae75340345f441e97",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 2
      },
      {
        "group": "hunts",
        "sha256": "3c0f77865de172cfc32cfb10f2ccdc1b69077ca2c9076d74c70d5af6676472a8",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "97ee31a0cd2430e632ebe79d5b8581d1e60dc7d29ea0b78cdbe0150a3a2e697c",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "27af6908a144b7881df6675c245691c5579c1ba16b8c1ec14b469d1f0220caae",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "5d47fad3236f628c065492b69792248c316b88cf8068944783977bdf0068fd10",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "db0b8c9c56c1fee00b1c6ff273807d8cab5076b3cad6be4676491bc0e96d2dbd",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "4863bbd3245e765a9b642b295f8e7cc1fbd6cdb12fc0fcec45f2e03c81b90791",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "98b5fafff467754d0e7f5c094029a09fdd83acc3d6aad6e6242caf38d4ab45f5",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "0df095644c65eda2db3706d00f27718017eaa1d88568d5c3fcfebb919ce0fbd8",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "6a9519fb7507191de365c3a5ecee36a83a2714fe124dd34a8e1487509bb975cd",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "5313791fa0fa458334fe15424c0ac2e8add8d4af25689bfdd2d757673e1a4d12",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "d59e24b1a9610da30908ee64b066a6832af3d0bfb3dfc705af771fff0e593ff3",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "c3c839ad1a1829a5fe4408ce288ffed7d8ba4d46ca1e88d5695c931dd4ea53ea",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "22dc09296c404a8ffdd6dcdd0a978034e218b64ffd0a2cb00b1f3da335e35446",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 5
      },
      {
        "group": "hunts",
        "sha256": "33a9f63217234c6a617b6042bd1c3e79b59b153d00a2b96f50ac3472a0b85243",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 4
      },
      {
        "group": "hunts",
        "sha256": "dd6576e23d074042505bdbcfe14c6467312199b7d4d7ebb28fad306375886894",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "6803382c5b4b9401526e1b2990b921adb2fa04098f3508b012450e5f9712d46f",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "a9aa04955c8ce227cfbfbf2853ee6acc1a97001d24d509effeb1fde07e687336",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "dc0fd2992d38ef57bda73553742c23c918fa96414ecae7cc8dfeb56220e1d797",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "52bd31f8c1d2a53f316e121ce4b5b476c4b3eead2cfa4e9d707ca7d5db7197bd",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "484efd51afe5635c37cc93f4fafa0c77495bd2029a8d4d133964a592244091d1",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "3299d1e655d809fc37d3286cb2a32f133093cdf97db7e987b101e39f5b49f63f",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "752efd823ab3f063429c677d217f9469ae503e025d39a04cdc4864bc5b56e468",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "b1eaee2ac521aa8a53018c0791c3ade8c51335b9cc15f3927e76373196e4bb0f",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "dd92187fee8a848003b883a15cfa9b232c116c4eed19821aaf55cb9cc7273636",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "24161759dbebdffeab21ded5153209650af1e9795f065ed839b13d7c5a4791d9",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 5
      },
      {
        "group": "hunts",
        "sha256": "78fab97d698d4a300ea59c42920bec556c30ffe37c9072d8652cb34a0e5a1fbb",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "572d023da8fa0705f8a720e3414cbb442a992948313f80612d06647fed50e3dc",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "d9df5f3de18d15c29f25d2323123651f2f882fa0094730a7658811dff48816a5",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "ff0bf38d10c7fa203a6fab9581e4c0862e382a70547b996767f77c2a7a6e824e",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "9852e3a00e0ccb9cbd3674957f3093e64e1c48ff0437793d8718dd59e72fd0db",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "6238da534c69f75d01b6aff98023440e2e0e467d01b016f0b272fb8e1b468a59",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "65c0701a81ae0e0daf2f38b36309facd85b93d661a9c015ecd320f109e43e801",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "0bc278246ffa25a8f4ecd7dbb59ce09b9ccc47ca2df9c1f6fe05c60869903245",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "f9d6189de03f39b1bbe9d248ddd95336385afb406f5b29d5354412fa6fbbc5aa",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "175a834c735dff708ddf89e7449e908413c92f2b28bded313d82b3815cd1e1d2",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "2a450dcfc10e4816dda3bbc8646bb12f1e7cfe9b7601e3b83b1402dfb9529ca2",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 5
      },
      {
        "group": "hunts",
        "sha256": "755511c0d2b01c62224085de84807b2f8cce23671b4116d11362121bfb722d68",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "396798bed39f577c08092c5d77be3c491cb45ed712a9e76f8e1bacb6cb24f1f0",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "826875aecad94541481f0eddfbc3139137738baf572d9571debbc620ea2dd14f",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "9dd5d7e51175485cbe246a074113318e634ad36623551e026a3955f957a10f55",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "e83c8a9d1efc2196c3e0579ac4bb0e272bd1450eb464956da60afc537b7d4137",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "b28c813c7ce234adcacf8ed89263a499d727469597211f64c98bd0d33e4a651c",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "c63c0a2adc31b8c445d60c571b4894c4d2a86d0571746156b27e0b4d767b091b",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "4679ba130ea80c36efe2f38ebf7b96b6088b0ea5b7c79b3aeed7312e71eb24e9",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "20f25671cd2cf29a966ce46edc117845130ad23a4164c07604889cc6d067851e",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 1
      },
      {
        "group": "hunts",
        "sha256": "ac7fb9550dbdb814a4c48dc49368a61dc27f84513d12f680de79b1a64b0beb64",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "38dbf01af57dabcadeaf851f4623c99dabf5b8fbb1dbbf0913c17e8031c80665",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "ef3ee106e07425befddf3ef4aeef7e38346484dcc6ae1f0fb34fd557a3517ea8",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "3d26ec520e1e8db7fab5557f861f44329a5e3a4944db2705a9a1c6ef05ffbd41",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "475bbf7875d5d193f50fcac487d52262dabd93e52c419f7d2a10d1da3e3edec9",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "23585e21500268983a7c8ad224590dd9afedd5c61ac749c877e22f40012a0952",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "5f91c8da6d5b2d3a389b3813c9911de80d712e31842f15626da52a419e6a6a66",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "f88cc2f408f10330b3a50933e1819dd8e616366c5705def338afdfa854084765",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "c008e5001a1bd0f9792ca689709c59f5aca1314a46ca88e31e35f27091f36ecb",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "hunts",
        "sha256": "cb11036892b778fb8c36ca7dc2f19e8f9c392217f71c8b9ee50766e317eb3fef",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 4
      },
      {
        "group": "hunts",
        "sha256": "aa0c0dac18c2e09dc8e95ae2b5c1d5783ce26d1ccd813806c6e4cbfc225adc12",
        "completedTurns": 0,
        "errorEvents": 0,
        "malformedLines": 2
      },
      {
        "group": "live-at-970953b",
        "sha256": "36e60af8f27380e6755a81af31f1c95fc49b018f02b843554137176790a7eb4f",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "live-at-970953b",
        "sha256": "923457ed299eeff7a28fd0e85e1945837572a5e97c80b4d8868efd3a191ce898",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "historical-live",
        "sha256": "10822d02cf2c6e21eed09acafd7aaf2c0fed22b64ef2ffb617e389f45a55acc6",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "historical-live",
        "sha256": "932f5cbc9605da6c07f3f4d1207984a9ed2136c65a6354e002079bafec65485e",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "historical-live",
        "sha256": "76aa8c5a4353d881f4b4c447734b44730f0c6200c9aacaef692362e5e3b8c35c",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "promotion-live",
        "sha256": "56a9e95d351453a77e8002f4a1a8156821a083de4c6ff111d67b6c510e9e89e3",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      },
      {
        "group": "promotion-live",
        "sha256": "99fb455033f8c4b27c00c0a0ac8d4d0f59eae6c9442718e976e5eeb981eb167b",
        "completedTurns": 1,
        "errorEvents": 0,
        "malformedLines": 0
      }
    ]
  },
  "sourceArtifacts": [
    {
      "label": "pandastack-phase1-final-usage.json",
      "sha256": "5a355f6f8b6e6dd7328dc836eb851f6bec1b53959e65c6d6e5bcd4361255ad7f"
    },
    {
      "label": "pandastack-phase1-final-hunt-status.json",
      "sha256": "ff85ac1a88ace42533efbf20a5877dc4b2080c0c1543529e91c4fb76159151db"
    },
    {
      "label": "pandastack-phase1-promotion-2cmdyc41-results.json",
      "sha256": "4acbcd8d5c0202ad521465034eb364e8278def4d544b8a889a90ab25a57fbc94"
    },
    {
      "label": "pandastack-phase1-final-doctor-provenance.json",
      "sha256": "62de55b60c2f59f6c8ec145e372e88168efe16eb11a497398796c2a21dde7d84"
    }
  ]
}
```
