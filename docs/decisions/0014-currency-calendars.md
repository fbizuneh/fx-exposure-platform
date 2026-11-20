# 0014 Business-day calendars per currency

Date: 2026-11-19. Services: master-data (holds the calendars), hedge-recommendation (uses them for value and fixing dates). Sources: decision 0011 item 8 (weekdays only until Master Data holds calendars), decision 0004 (how master data is versioned and arrives), the product owner's answers of 2026-11-19.

## Decided
1. **Whose calendars.** A recommendation's value date must be a business day in **both currencies of the pair**. A day is a business day for the pair only if it is open in each.
2. **Roll rule: modified following.** The date (as-of plus tenor) rolls forward to the next business day; if that falls in another month, it rolls back to the last business day before it instead. This replaces "roll forward to a weekday"; it differs from before only at month ends.
3. **NDF fixing date.** Two business days before the value date, counted over the **pair's joint calendar** (days open in both currencies).
4. **When a calendar is missing or too short: weekends only, and say so.** A currency with no calendar on record counts Saturdays and Sundays as its only non-business days, and so does a currency whose holidays are known only to a date before the value date. The recommendation then lists the currencies concerned (`calendarGaps`, reason `NO_CALENDAR` or `CALENDAR_ENDED`, with the plain-language messages in the contract). The fallback is applied **day by day**: on a day after a calendar's covered-through date (or with no calendar), that currency is closed only on Saturdays and Sundays, whatever weekend days its expired calendar lists, in both the roll and the fixing count. Inside the cover the calendar is obeyed. The warning is judged against the latest day looked at (when a roll runs forward into the next month and then back, that forward day counts). A group with no trade has no dates and no gaps.

## Defaults I chose (change them if you disagree)
- **Tenant-level.** Calendars are tenant master data like the rest (every row carries the tenant), loaded by change set. A shared platform-level calendar, seeded for every tenant, is a later step (the same open question as the NDF list).
- **One row per currency**: its weekend days (default Saturday and Sunday, any of the seven, at most three, so a Friday and Saturday weekend works), the holidays (date and optional name) and a **covered-through** date: the holidays are listed up to and including it, and the calendar says nothing beyond it. A holiday after the covered-through date is refused. It is a new change-set kind, `CALENDAR`, with the same versioning (valid-from and valid-to), snapshot and partial modes, hold safeguard, announcement and audit record as currencies. The same calendar sent in another order is not a change.
- **Master Data answers with data, Hedge Recommendation applies the convention.** The question is `getCalendars(tenant, currencies, asOf)`; a currency with no calendar is left out. Which roll rule and which count of fixing days apply is a hedging convention, so it lives in the service that makes the recommendation and can differ by strategy later.
- **Read as of today, not the cycle's as-of date.** Holidays are loaded ahead, and a calendar loaded today is the best knowledge for dates being worked out today; reading as of the cycle date would miss a calendar loaded after it. A rerun or a late run therefore uses the calendar as it stands when it runs. Recommendations already issued are not recomputed; decisions are frozen at approval.
- **The fixing lag stays 2 business days** and the tenor is still counted in calendar days or months from the as-of date (no spot lag).
- Existing recommendations gain `calendarGaps` (empty) by migration; a calendar can only be fixed by loading one and rerunning.

## Not built (recorded)
- A platform-level default calendar and bank-holiday feeds; Exposure Management's schedule offset in business days; settlement or value-date checks in FX Trade; a spot lag (T+2) and USD as a third required calendar for crosses; recomputing dates of issued recommendations when a calendar changes; the screens.

## Revisit when
A strategy needs a convention other than modified following, or tenants want one shared calendar source.
