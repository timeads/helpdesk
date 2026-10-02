-- Commercial invoices: the customs list a label was bought with (reprint the invoice later)
ALTER TABLE shipments ADD COLUMN customs TEXT;
