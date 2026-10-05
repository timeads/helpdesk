-- A repair topic copied (and adapted) from another machine's topic
ALTER TABLE manual_topics ADD COLUMN copied_from INTEGER REFERENCES manual_topics(id) ON DELETE SET NULL;
