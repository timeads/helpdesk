-- Holds can end on a date: the order comes back to the shipping queue that day (store time)
ALTER TABLE order_holds ADD COLUMN hold_until TEXT; -- YYYY-MM-DD
