# Open-weight model license checklist

Mark each item ✅ OK, ⚠️ check, or ❌ blocker. When in doubt, use ⚠️.

| # | Item | ✅ OK when | ⚠️ / ❌ when |
| --- | --- | --- | --- |
| 1 | **License identified** | A named license id is on the model card (for example `apache-2.0`, `mit`) | ⚠️ `other`, custom, or missing |
| 2 | **Commercial use** | Permissive license (Apache-2.0, MIT, BSD) | ⚠️ community or custom license with conditions; ❌ non-commercial or research-only (for example CC-BY-NC) |
| 3 | **User or revenue thresholds** | None | ⚠️ license limits by monthly active users, revenue, or company size |
| 4 | **Acceptable use policy** | None, or general | ⚠️ separate acceptable use policy that restricts use cases |
| 5 | **Attribution and notices** | Simple notice requirement | ⚠️ must display a name, logo, or "built with" text |
| 6 | **Output restrictions** | None | ⚠️ limits on using outputs to train other models |
| 7 | **Gated access** | Not gated | ⚠️ gated: users must accept terms on Hugging Face |
| 8 | **Base model** | Original model, or base model license is also OK | ⚠️ fine-tune, merge, or conversion: check the base model's license too |
| 9 | **Training data disclosure** | Data sources described on the card | ⚠️ not described: harder to assess copyright and privacy risk |
| 10 | **Maintenance** | Updated in the last 12 months, active community | ⚠️ stale or archived |
| 11 | **Publisher** | Known organization or verified publisher | ⚠️ unknown individual account; check that it isn't a copy of another model |

Always end with: "This isn't legal advice. Confirm with your legal team before shipping."
