-- =====================================================================
--  Chispa · base de datos de moderación (Supabase)
--  Pega TODO este archivo en Supabase → SQL Editor → Run.
--  Se puede ejecutar varias veces sin romper nada.
--
--  Guarda:
--   · visits  : cada entrada a la app (IP, dispositivo, nombre, sala)
--   · reports : reportes con captura del video de la persona reportada
--   · bans    : bloqueos por IP o por dispositivo
--   · admins  : correos que pueden entrar al panel /admin
--
--  Seguridad: nadie puede leer ni escribir las tablas directamente
--  desde la app; solo a través de las funciones de abajo. El panel
--  /admin lee todo porque inicia sesión con un correo de "admins".
-- =====================================================================

create table if not exists public.admins (
  email text primary key
);

create table if not exists public.visits (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  ip text,
  device text,
  peer text,
  name text,
  sala text,
  user_agent text
);
create index if not exists visits_peer_idx on public.visits (peer);
create index if not exists visits_ip_idx on public.visits (ip);
create index if not exists visits_created_idx on public.visits (created_at desc);

create table if not exists public.bans (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('ip', 'device')),
  value text not null,
  reason text,
  expires_at timestamptz,
  unique (kind, value)
);

create table if not exists public.reports (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  status text not null default 'pendiente' check (status in ('pendiente', 'resuelto', 'descartado')),
  reason text,
  details text,
  sala text,
  reporter_ip text,
  reporter_device text,
  reporter_name text,
  reporter_peer text,
  reported_ip text,
  reported_device text,
  reported_name text,
  reported_peer text,
  image text
);
create index if not exists reports_created_idx on public.reports (created_at desc);

alter table public.admins enable row level security;
alter table public.visits enable row level security;
alter table public.bans enable row level security;
alter table public.reports enable row level security;

-- ¿La sesión actual es de un administrador?
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- Políticas: solo administradores pueden ver y cambiar las tablas.
drop policy if exists admin_all_visits on public.visits;
create policy admin_all_visits on public.visits
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists admin_all_bans on public.bans;
create policy admin_all_bans on public.bans
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists admin_all_reports on public.reports;
create policy admin_all_reports on public.reports
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists admin_read_admins on public.admins;
create policy admin_read_admins on public.admins
  for select to authenticated using (public.is_admin());

-- IP real de quien llama (la pone el servidor, no la puede inventar el navegador).
create or replace function public.client_ip()
returns text
language sql stable
as $$
  select nullif(trim(coalesce(
    current_setting('request.headers', true)::json ->> 'cf-connecting-ip',
    current_setting('request.headers', true)::json ->> 'x-real-ip',
    split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1)
  )), '');
$$;

-- Busca un bloqueo vigente para una IP o un dispositivo.
create or replace function public.find_ban(p_ip text, p_device text)
returns public.bans
language sql stable security definer set search_path = public
as $$
  select * from bans
  where ((kind = 'ip' and value = p_ip) or (kind = 'device' and value = p_device))
    and (expires_at is null or expires_at > now())
  order by created_at desc
  limit 1;
$$;

-- Se llama al entrar a la app: registra la entrada y dice si está bloqueado.
create or replace function public.check_in(
  p_peer text, p_device text, p_name text, p_sala text, p_ua text
)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_ip text := client_ip();
  v_ban bans;
  v_recent int;
begin
  select count(*) into v_recent from visits
  where ip = v_ip and created_at > now() - interval '10 minutes';
  if v_recent < 60 then
    insert into visits (ip, device, peer, name, sala, user_agent)
    values (v_ip, left(p_device, 64), left(p_peer, 64), left(p_name, 24), left(p_sala, 32), left(p_ua, 200));
  end if;

  v_ban := find_ban(v_ip, left(p_device, 64));
  if v_ban.id is not null then
    return json_build_object('banned', true, 'reason', v_ban.reason, 'until', v_ban.expires_at);
  end if;
  return json_build_object('banned', false);
end;
$$;

-- El anfitrión de cada sala pregunta si un participante entró bien y no está bloqueado.
create or replace function public.peer_allowed(p_peer text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
      select 1 from visits v
      where v.peer = p_peer and v.created_at > now() - interval '12 hours'
    )
    and not exists (
      select 1 from visits v
      join bans b on (b.kind = 'ip' and b.value = v.ip) or (b.kind = 'device' and b.value = v.device)
      where v.peer = p_peer and (b.expires_at is null or b.expires_at > now())
    );
$$;

-- Enviar un reporte (con captura opcional en JPEG).
create or replace function public.submit_report(
  p_reported_peer text, p_reported_name text, p_reason text, p_details text,
  p_sala text, p_image text, p_reporter_peer text, p_reporter_device text, p_reporter_name text
)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_ip text := client_ip();
  v_recent int;
  v_target visits;
  v_image text := p_image;
begin
  select count(*) into v_recent from reports
  where reporter_ip = v_ip and created_at > now() - interval '10 minutes';
  if v_recent >= 10 then
    return json_build_object('ok', false, 'error', 'Demasiados reportes seguidos. Intenta más tarde.');
  end if;

  if v_image is not null and (length(v_image) > 400000 or v_image not like 'data:image/jpeg;base64,%') then
    v_image := null;
  end if;

  select * into v_target from visits
  where peer = p_reported_peer
  order by created_at desc
  limit 1;

  insert into reports (
    reason, details, sala, image,
    reporter_ip, reporter_device, reporter_name, reporter_peer,
    reported_ip, reported_device, reported_name, reported_peer
  ) values (
    left(p_reason, 60), left(p_details, 500), left(p_sala, 32), v_image,
    v_ip, left(p_reporter_device, 64), left(p_reporter_name, 24), left(p_reporter_peer, 64),
    v_target.ip, v_target.device, coalesce(left(p_reported_name, 24), v_target.name), left(p_reported_peer, 64)
  );
  return json_build_object('ok', true);
end;
$$;

-- Limpieza de privacidad: borra entradas viejas (lo usa el panel).
create or replace function public.purge_old_visits(p_days int default 30)
returns int
language plpgsql security definer set search_path = public
as $$
declare v_count int;
begin
  if not is_admin() then raise exception 'Solo administradores'; end if;
  delete from visits where created_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.find_ban(text, text) from public, anon, authenticated;
grant execute on function public.check_in(text, text, text, text, text) to anon, authenticated;
grant execute on function public.peer_allowed(text) to anon, authenticated;
grant execute on function public.submit_report(text, text, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.purge_old_visits(int) to authenticated;

-- =====================================================================
--  ÚLTIMO PASO: pon aquí el correo con el que entrarás al panel /admin
--  (primero créalo en Authentication → Users → Add user).
-- =====================================================================
-- insert into public.admins (email) values ('TU_CORREO_ADMIN@ejemplo.com') on conflict do nothing;
