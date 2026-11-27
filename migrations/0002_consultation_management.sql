ALTER TABLE consultations ADD COLUMN consultation_code TEXT;
ALTER TABLE consultations ADD COLUMN status TEXT NOT NULL DEFAULT 'new'
  CHECK (status IN ('new', 'review', 'booked', 'completed'));
ALTER TABLE consultations ADD COLUMN admin_note TEXT NOT NULL DEFAULT '';
ALTER TABLE consultations ADD COLUMN updated_at TEXT;
ALTER TABLE consultations ADD COLUMN consent_version TEXT;

UPDATE consultations SET consultation_code = 'KY-' || upper(replace(id, '-', ''))
WHERE consultation_code IS NULL;

CREATE UNIQUE INDEX consultations_code ON consultations(consultation_code);

-- Older Pages deployments omit the code, including during rollback.
CREATE TRIGGER consultations_assign_legacy_code AFTER INSERT ON consultations
WHEN NEW.consultation_code IS NULL
BEGIN
  UPDATE consultations SET consultation_code = 'KY-' || upper(replace(NEW.id, '-', ''))
  WHERE id = NEW.id;
END;
