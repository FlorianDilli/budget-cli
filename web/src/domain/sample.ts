// Synthetic first-run content. It is shown as a draft and is saved only when the
// user saves it (Decision 15 / merge rule 5). It contains no real figures.

export const SAMPLE_SETTINGS = `# Sample settings (synthetic). Edit and press Save to keep.
[user]
currency_symbol = "EUR"
round_amounts   = false
total_money_as_of_day = 0

[[importer.formats]]
name               = "Demo Bank"
date_column        = "Booking Date"
description_column = "Payee"
reference_column   = "Reference"
amount_column      = "Amount"
delimiter          = ","
date_format        = "%Y-%m-%d"
decimal_separator  = "."
balance_snapshot      = 1000.00
balance_snapshot_date = "2025-01-01"
`;

export const SAMPLE_FINANCIALS = `# Sample financials (synthetic). Edit and press Save to keep.
[category_rules]
"Groceries"     = ["market", "grocer"]
"Utilities"     = ["power", "water"]
"Subscriptions" = ["streamflix", "musicbox"]

[[recurring_transactions]]
description       = "Salary Demo Corp"
amount            = 2500.00
recurrence_months = 1

[[recurring_transactions]]
description       = "Apartment Rent"
amount            = -850.00
recurrence_months = 1
start_date        = "2025-01-01"

[[recurring_transactions]]
description       = "Streamflix"
amount            = -12.99
recurrence_months = 1
amount_history = [
  { from = "2025-01-01", amount = -9.99 },
]

[[recurring_transactions]]
description       = "Annual Insurance"
amount            = -240.00
recurrence_months = 12
payment_month     = 3

[cash]
entries = [
  { date = "2025-01-01", amount = 100.00 },
]
`;
