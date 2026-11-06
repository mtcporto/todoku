ALTER TABLE hub_templates ADD COLUMN presentation_json TEXT CHECK(presentation_json IS NULL OR json_valid(presentation_json));
-- statement-breakpoint
ALTER TABLE hub_applications ADD COLUMN branding_json TEXT CHECK(branding_json IS NULL OR json_valid(branding_json));
