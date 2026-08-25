// Filled in once, by whoever sets up the Supabase project — safe to be public.
// The anon key is designed to be exposed client-side; Row Level Security in
// schema.sql is what actually protects the data, not keeping this secret.
window.CTORQ_CONFIG = {
  SUPABASE_URL: 'https://byuayuyuzwmtbvyiweyu.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_dq6sJFnmW9M8aWvbf1ysTA_MhDcD6Ik',
  APP_URL: 'https://anuwilfred.github.io/C-torq-Work-Flow-App', // update to your real published Pages URL
  // Public VAPID key for Web Push notifications — safe to expose client-side,
  // it only lets the browser verify pushes came from our matching private key.
  VAPID_PUBLIC_KEY: 'BC_TISxEoDsVTpvh4F0JcTQD-oF8L6XvMvRMi5CfrmpsRtiqKUytW-WsqlhCxi7EMZlqNF3NN6ySdJ2twrPKtz4'
};
