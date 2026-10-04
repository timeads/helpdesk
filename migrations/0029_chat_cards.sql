-- Chat answers can carry cards under the text: the articles the AI used and products it recommends (JSON)
ALTER TABLE messages ADD COLUMN extra TEXT;
