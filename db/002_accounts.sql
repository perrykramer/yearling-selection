-- The four accounts, for reference and for rebuilding the project from scratch.
--
-- These were created once, directly against auth.users, because there is no signup
-- flow: Perry issues accounts and hands out passwords. Real passwords are NOT in this
-- repo — replace the placeholders below before running, and change them afterwards.
--
-- The addresses are @westpaces.local, which receives no mail. That is deliberate: this
-- system has no password-reset email, because a link is no use to someone at a barn with
-- no signal. Perry resets passwords in the dashboard. If you ever want self-service
-- reset, give these accounts real addresses first.
--
-- display_name is read by the handle_new_user trigger in 001_schema.sql and copied into
-- public.profiles, which is where the app gets the names it shows on notes and verdicts.

do $$
declare v_id uuid; r record;
begin
  for r in select * from (values
      ('conor@westpaces.local','REPLACE-ME','Conor Foley'),
      ('nick@westpaces.local', 'REPLACE-ME','Nick Esler'),
      ('larry@westpaces.local','REPLACE-ME','Larry Connolly'),
      ('perry@westpaces.local','REPLACE-ME','Perry Kramer')
    ) as t(email, pw, name)
  loop
    if exists (select 1 from auth.users u where u.email = r.email) then continue; end if;

    v_id := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
      r.email, extensions.crypt(r.pw, extensions.gen_salt('bf')), now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('display_name', r.name),
      '', '', '', ''
    );

    -- Password sign-in needs the matching identity row, not just the user row.
    insert into auth.identities (
      provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
    ) values (
      v_id::text, v_id,
      jsonb_build_object('sub', v_id::text, 'email', r.email,
                         'email_verified', true, 'phone_verified', false),
      'email', now(), now(), now()
    );
  end loop;
end $$;

select u.email, p.display_name from auth.users u join public.profiles p on p.id = u.id;
