# 0029 — Interpolate forward rates in the UAT simulator

Fikre chose interpolation between bracketing forward quotes for the demo simulator on 2026-11-20. Scenario 5's BS-REG Close-out+New can request a valid roll value date that is absent from E3's tenor quotes (for example, BRL/AED on 2027-01-28).

The simulator uses an exact quote first. For a missing exact forward date, it linearly interpolates the all-in rate by calendar-day distance between the nearest earlier and later quotes for the same pair. It uses decimal arithmetic and rounds the interpolated rate to ten decimal places before calculating the executed settlement amount. Inverse rates and the USD cross remain available; each cross leg is interpolated independently when necessary. It refuses a date outside the quoted range. Spot rates are never interpolated.

Cost: simulated forward rates between quoted tenor dates are derived values. E3's files and FX Rate service behavior do not change.
