# Cortex — 3-minute video pitch script

**Setup before recording:** run `npm run reset`, open http://localhost:3000, and keep the `demo-uploads/` folder open next to the browser for drag-and-drop. If you have an API key, start the server with it so the pill reads *"Agents on claude-opus-5-5"*.

| Time | On screen | Say |
|---|---|---|
| **0:00–0:20** | Title slide, then the Cortex dashboard | "Google Drive is a filing cabinet. Files go in, nobody reads them, and they quietly contradict each other. Cortex is a drive with a team of AI agents that *read everything*, organize it, catch mistakes and do the paperwork." |
| **0:20–0:45** | Sidebar smart folders; hover a card | "We never created a folder. The Librarian agent read each file, and the Organizer built these smart folders from the content: Aurora Launch, Office Relocation, Finance. Every file has a summary, tags, people and key facts." |
| **0:45–1:10** | Red conflict cards at the top. Open the Insights view | "Here's the aha moment. The Sentinel agent cross-checks every file. Our kickoff and the budget sheet say paid social is $45,000, but the August sync raised it to $52,000. Cortex caught that the budget sheet is stale, and shows which source is newest." |
| **1:10–1:35** | Click the chip *"What is the current paid social budget?"* Click a citation number | "Ask in plain English. The Retriever searches every passage, the Analyst answers with citations. It weights newer documents and warns me about the conflict." |
| **1:35–2:00** | Drag **Lease Agreement** and the **EventSpace invoice** onto the page. Show the trace, the new conflict and the Expense Ledger | "Now I drop in the signed lease and an invoice. Watch the trace: the lease is filed into Office Relocation, and the Sentinel flags that the lease says $15,200 a month while our plan budgeted $14,500. The invoice triggered a workflow that logged $12,300 under Events in our auto-maintained Expense Ledger." |
| **2:00–2:30** | Click chip *"Draft a launch requirements doc from the Aurora meetings"*. Open the new doc. Then drag **Aurora Beta Customer Interviews** in, and the doc gets the **↻ stale** badge; click **Refresh** | "Cross-document synthesis: I didn't select anything; the Router picked the three meetings itself, and the Writer reconciled them into a requirements doc. It's a *living document*: when new interview notes arrive, it flags itself stale, and one click regenerates version 2." |
| **2:30–2:50** | Automations view: type *"When a contract is uploaded, extract the landlord, monthly rent, start date and renewal terms into Contracts.csv"* | "And you can teach it new habits in plain English. The Automator turns that sentence into a workflow and backfills the lease that's already here." |
| **2:50–3:00** | *Brief me on my drive* | "Cortex: storage that reads, remembers, notices and acts. Thank you." |

**Backup lines if asked about tech:** Each agent is a Claude Opus 5.5 call with a strict JSON schema (structured outputs). Retrieval is hybrid: BM25 over passage chunks plus LLM query expansion. Every agent has a deterministic offline fallback, so the demo runs even without an API key.
