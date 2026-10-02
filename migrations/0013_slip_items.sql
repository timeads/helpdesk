-- Packing slips: leave SKU and product barcode off (item names print larger instead)
UPDATE settings
SET value = json_set(value, '$.showSku', json('false'), '$.showItemBarcode', json('false'))
WHERE key = 'slip_layout' AND json_valid(value);
