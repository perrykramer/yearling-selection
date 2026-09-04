/* Both values are public by design: the publishable key identifies the project, it does
   not grant access. Every row is protected by row level security, so an unauthenticated
   caller holding this key can read nothing. */
window.SALEBOOK_CONFIG = {
  supabaseUrl: 'https://pjwoavkqctmgvqmhfaos.supabase.co',
  supabaseKey: 'sb_publishable_dI1-bLTIOFnUWIqc3Kd4MA_D2_6cG_J',
  catalog:     'data/catalog.v1.json'
};
