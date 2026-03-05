/*
  # Crear tabla de credenciales de Unleashed

  ## Descripción
  Esta migración crea una tabla para almacenar las credenciales de API de Unleashed
  de forma persistente y segura en la base de datos.

  1. Nueva Tabla
    - `unleashed_credentials`
      - `id` (uuid, primary key) - Identificador único del registro
      - `api_id` (text, not null) - API ID de Unleashed
      - `api_key` (text, not null) - API Key de Unleashed
      - `created_at` (timestamptz) - Fecha de creación del registro
      - `updated_at` (timestamptz) - Fecha de última actualización
      - `is_active` (boolean) - Indica si estas son las credenciales activas

  2. Seguridad
    - Enable RLS en la tabla
    - Política para permitir SELECT a todos (necesario para anon key)
    - Política para permitir INSERT y UPDATE a todos (necesario para anon key)
    - Se asegura que solo exista un registro activo a la vez

  ## Notas
  - Las credenciales se almacenan en texto plano ya que necesitan ser usadas
    para autenticación con la API de Unleashed
  - Solo puede haber un registro activo a la vez
  - La app usará el registro donde is_active = true
*/

-- Crear la tabla de credenciales de Unleashed
CREATE TABLE IF NOT EXISTS unleashed_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_id text NOT NULL,
  api_key text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  is_active boolean DEFAULT true
);

-- Habilitar RLS
ALTER TABLE unleashed_credentials ENABLE ROW LEVEL SECURITY;

-- Política para permitir SELECT a todos
CREATE POLICY "Allow public read access"
  ON unleashed_credentials
  FOR SELECT
  USING (true);

-- Política para permitir INSERT a todos
CREATE POLICY "Allow public insert"
  ON unleashed_credentials
  FOR INSERT
  WITH CHECK (true);

-- Política para permitir UPDATE a todos
CREATE POLICY "Allow public update"
  ON unleashed_credentials
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- Función para asegurar que solo un registro esté activo
CREATE OR REPLACE FUNCTION ensure_single_active_credential()
RETURNS TRIGGER AS $$
BEGIN
  -- Si el nuevo registro es activo, desactivar todos los demás
  IF NEW.is_active = true THEN
    UPDATE unleashed_credentials
    SET is_active = false, updated_at = now()
    WHERE id != NEW.id AND is_active = true;
  END IF;
  
  -- Actualizar updated_at
  NEW.updated_at = now();
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para ejecutar la función antes de INSERT o UPDATE
CREATE TRIGGER trigger_ensure_single_active_credential
  BEFORE INSERT OR UPDATE ON unleashed_credentials
  FOR EACH ROW
  EXECUTE FUNCTION ensure_single_active_credential();

-- Crear índice para búsquedas rápidas por is_active
CREATE INDEX IF NOT EXISTS idx_unleashed_credentials_active
  ON unleashed_credentials(is_active)
  WHERE is_active = true;