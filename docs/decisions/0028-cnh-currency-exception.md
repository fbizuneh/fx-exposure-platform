# 0028 — CNH is accepted as a currency code

Fikre decided on 2026-11-20 that the platform accepts `CNH` (offshore deliverable yuan) alongside `CNY`, as a deliberate exception to the ISO 4217 rule. `CNH` is a market convention, not an ISO code, but treasury teams hedge and report it separately from `CNY`, so a GL file or rate file that carries it is valid.

Data Source's row check (`GL_CURRENCY_UNSUPPORTED`) accepted only the codes in `Intl.supportedValuesOf("currency")`, which does not list `CNH`. It now accepts that list plus a short, explicit list of exceptions (`NON_ISO_CURRENCIES` in `services/data-source/src/validate.ts`). Adding another exception is a decision, like this one. Master Data, FX Rate and FX Trade already accepted any three-letter code, so nothing changes there.

Found by the E-stream rehearsal: the generated UAT pack uses `CNH` among its 40 currencies, and without this change Data Source blocked 553 rows of every clean GL file.

Cost: the list of exceptions is one more thing to keep. The ISO part of the check still depends on the Node/ICU build that runs the service; an explicit ISO list is a separate, larger change and is not made here.
