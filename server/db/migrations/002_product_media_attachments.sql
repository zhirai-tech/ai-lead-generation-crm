-- =====================================================================
-- 002: product media / documents, AI keywords, email attachments
-- =====================================================================

-- AI-generated / user-edited search keywords for a product.
ALTER TABLE products ADD COLUMN keywords_json TEXT NOT NULL DEFAULT '[]';

-- Optional main image (references product_files.id; no FK to keep ALTER simple).
ALTER TABLE products ADD COLUMN main_image_file_id TEXT;

-- Distinguish product images from documents (PDF catalogues, spec sheets).
ALTER TABLE product_files ADD COLUMN kind TEXT NOT NULL DEFAULT 'document'
  CHECK (kind IN ('image', 'document'));

CREATE INDEX IF NOT EXISTS idx_product_files_product ON product_files(product_id, kind);

-- Attachments selected for an outbound draft: [{productFileId, filename, mimeType, sizeBytes, publicUrl}]
ALTER TABLE message_drafts ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';

-- What was actually attached to the sent message (audit trail).
ALTER TABLE email_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
