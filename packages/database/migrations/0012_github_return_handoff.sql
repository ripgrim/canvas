ALTER TABLE app_github_installation_state
  ADD COLUMN IF NOT EXISTS return_to_url text;

ALTER TABLE app_github_installation_state
  ADD CONSTRAINT app_github_installation_state_return_url_check CHECK (
    return_to_url IS NULL OR char_length(return_to_url) BETWEEN 8 AND 4096
  );
