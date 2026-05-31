# Task Dependency Graph: F9 — Admin Dashboard + Directory + Timeline + Audit

**Source**: `specs/015-admin-dashboard/tasks.md` (105 tasks, 9 phases)
**Generated**: 2026-05-25 · **Read-only artifact** (regenerate via `/speckit.diagram.dependencies`)

> 105 tasks (>30) → grouped at the **phase level** with inter-phase edges, plus a
> task-level critical-path view.

## Phase-level DAG (execution waves)

```mermaid
flowchart LR
    subgraph W1["Wave 1 — ready now"]
        P1["Phase 1: Setup<br/>T001–T005"]
    end

    subgraph W2["Wave 2 — blocking gate"]
        P2["Phase 2: Foundational<br/>T006–T019 · migrations+RLS+isolation"]
    end

    subgraph W3["Wave 3 — parallel after Foundational"]
        P3["Phase 3: US1 Dashboard P1 🎯<br/>T020–T038 · Slice A"]
        P4["Phase 4: US2 Audit P2<br/>T039–T050 · Slice A"]
        P5["Phase 5: US3 Timeline P3<br/>T051–T059 · Slice A"]
        P6["Phase 6: US4 Benefits P3<br/>T060–T068 · Slice A"]
        P7["Phase 7: US5 Directory+E-Book P4<br/>T069–T085 · Slice B (export infra)"]
    end

    subgraph W4["Wave 4 — depends on US5 export infra"]
        P8["Phase 8: US6 GDPR Export P4<br/>T086–T095 · Slice B"]
    end

    subgraph W5["Wave 5 — after in-scope stories"]
        P9["Phase 9: Polish & Cross-Cutting<br/>T096–T105 · incl. Principle I gate T102"]
    end

    P1 --> P2
    P2 --> P3
    P2 --> P4
    P2 --> P5
    P2 --> P6
    P2 --> P7
    P7 --> P8
    P3 --> P9
    P4 --> P9
    P5 --> P9
    P6 --> P9
    P8 --> P9

    style P1 fill:#FFC107,color:#000
    style P2 fill:#9E9E9E,color:#fff
    style P3 fill:#9E9E9E,color:#fff
    style P4 fill:#9E9E9E,color:#fff
    style P5 fill:#9E9E9E,color:#fff
    style P6 fill:#9E9E9E,color:#fff
    style P7 fill:#9E9E9E,color:#fff
    style P8 fill:#9E9E9E,color:#fff
    style P9 fill:#9E9E9E,color:#fff
```

## Critical path (task-level — longest chain)

```mermaid
flowchart LR
    T006["T006 0185 cache table"] --> T010["T010 0189 timeline view"]
    T010 --> T012["T012 apply+integration"]
    T012 --> T069["T069 private-blob adapter"]
    T069 --> T070["T070 export-job state machine"]
    T070 --> T071["T071 processExportJob worker"]
    T071 --> T089["T089 requestDataExport (US6)"]
    T089 --> T090["T090 GDPR archive builder"]
    T090 --> T091["T091 audit-subset redaction"]
    T091 --> T092["T092 wire gdpr kind"]
    T092 --> T102["T102 cross-tenant gate GREEN"]
    T102 --> T104["T104 full CI"]
    T104 --> T105["T105 security co-sign"]

    style T006 fill:#FFC107,color:#000
    style T010 fill:#FFC107,color:#000
    style T012 fill:#FFC107,color:#000
```

**Critical path**: T006 → T010 → T012 → T069 → T070 → T071 → T089 → T090 → T091 → T092
→ T102 → T104 → T105 (**~13 sequential tasks**). Slice B (US5→US6 serial, sharing export
infra) is the schedule driver, not Slice A.

## Legend
- 🟡 Yellow — ready (deps met, not done)
- ⚪ Gray — blocked (waiting on upstream phase)
- 🟢 Green — completed (none yet)

## Execution waves

| Wave | Phase(s) | Can start when |
|------|----------|----------------|
| **1** | P1 Setup | now |
| **2** | P2 Foundational | Setup done — **blocks everything** |
| **3** | P3 US1 · P4 US2 · P5 US3 · P6 US4 · P7 US5 | Foundational done (5-way parallel if staffed) |
| **4** | P8 US6 | US5 export infra (T069–T073) done |
| **5** | P9 Polish | in-scope stories done |

## Statistics
- **Total tasks**: 105 · **Completed**: 0 (0%) · **Ready now**: Phase 1 (T001–T005) · **Blocked**: 100
- **Phases**: 9 · **Execution waves**: 5
- **No cycles detected** — valid DAG ✅
- **Max parallelism**: Wave 3 (US1–US4 + US5 = up to 5 stories concurrently after Foundational)
- **Schedule driver**: Slice B serial chain (US5 → US6) — US6 depends on US5's shared export infra (T069–T073)

### Notes
- Within each story phase, TDD forces a sub-ordering: **tests (RED) → domain → application → infrastructure → presentation**, so per-story tasks aren't fully parallel internally.
- **T019** (cross-tenant RED harness) and **T102** (cross-tenant GREEN) bracket the Principle I Review-Gate blocker.
- Single-developer order: P3→P4→P5→P6 (Slice A) then P7→P8 (Slice B).
