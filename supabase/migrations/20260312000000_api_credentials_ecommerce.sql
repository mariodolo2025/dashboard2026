-- Tabla para credenciales de APIs (Shopify, Meta) para el tab E-commerce
-- Solo accesible vía Edge Functions con service role (no exponer al cliente)

CREATE TABLE IF NOT EXISTS api_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL UNIQUE CHECK (provider IN ('shopify', 'meta')),
  -- Shopify: store URL (ej. mi-tienda.myshopify.com)
  store_url text,
  -- Token de acceso (Shopify Admin API o Meta Marketing API)
  access_token text,
  -- Meta: IDs de cuentas de ads separados por coma (ej. act_123,act_456)
  ad_account_ids text,
  updated_at timestamptz DEFAULT now()
);

-- RLS: ninguna política para anon - solo service role puede leer/escribir
ALTER TABLE api_credentials ENABLE ROW LEVEL SECURITY;

-- Sin políticas públicas - las Edge Functions usan service role
-- Esto evita que el cliente acceda directamente a las credenciales
