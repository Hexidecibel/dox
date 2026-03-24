-- Create default tenant
INSERT OR IGNORE INTO tenants (id, name, slug, description)
VALUES ('default', 'System', 'system', 'Default system tenant');

-- Create default admin user (password: admin123 - CHANGE IN PRODUCTION)
-- Password hash is a placeholder - will be set properly via the app
INSERT OR IGNORE INTO users (id, email, password_hash, name, role, tenant_id)
VALUES ('admin', 'admin@docportal.local', 'CHANGE_ME_VIA_APP', 'System Admin', 'super_admin', NULL);

-- Default site settings
INSERT OR IGNORE INTO site_settings (key, value, group_name) VALUES ('site_name', 'Document Portal', 'general');
INSERT OR IGNORE INTO site_settings (key, value, group_name) VALUES ('max_file_size_mb', '100', 'uploads');
INSERT OR IGNORE INTO site_settings (key, value, group_name) VALUES ('allowed_file_types', '["pdf","doc","docx","xls","xlsx","csv","txt","png","jpg","jpeg"]', 'uploads');
