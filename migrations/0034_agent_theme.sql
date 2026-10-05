-- Each person's colour theme for the help desk: follow the device, or always light / always dark
ALTER TABLE agents ADD COLUMN theme TEXT NOT NULL DEFAULT 'system';
