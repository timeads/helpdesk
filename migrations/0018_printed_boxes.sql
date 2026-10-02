-- Multi-box labels printed one box at a time: which boxes (1-based) have been printed
ALTER TABLE shipments ADD COLUMN printed_boxes TEXT NOT NULL DEFAULT '[]';
