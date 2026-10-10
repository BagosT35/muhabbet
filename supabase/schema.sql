-- Muhabbet — veritabanı kurulumu
-- Supabase panelinde: SQL Editor > New query > bu dosyanın tamamını yapıştır > Run.
-- ÇALIŞTIRMADAN ÖNCE en alttaki davet kodunu kendi belirlediğin bir kodla değiştir.

-- ---------- Tablolar ----------

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text not null unique check (char_length(username) between 2 and 24),
  created_at timestamptz not null default now()
);

create table public.channels (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 32),
  kind text not null check (kind in ('text', 'voice')),
  created_at timestamptz not null default now()
);

create table public.messages (
  id bigint generated always as identity primary key,
  channel_id bigint not null references public.channels on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles on delete cascade,
  content text not null check (char_length(content) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index messages_channel_idx on public.messages (channel_id, id desc);

-- Tek satırlık ayar tablosu. Hiçbir politika tanımlı değil: istemciden okunamaz.
create table public.server_settings (
  id boolean primary key default true check (id),
  invite_code text not null
);

-- ---------- Fonksiyonlar ----------

-- Giriş yapan kişi sunucuya katılmış mı (profili var mı)?
create function public.is_member()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()));
$$;

-- Davet kodu doğruysa profil oluşturur. Sunucuya girmenin tek yolu budur.
create function public.join_server(code text, uname text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Önce giriş yapmalısın';
  end if;
  if not exists (select 1 from public.server_settings where invite_code = code) then
    raise exception 'Davet kodu yanlış';
  end if;
  insert into public.profiles (id, username) values ((select auth.uid()), trim(uname));
end;
$$;

revoke execute on function public.is_member() from public, anon;
revoke execute on function public.join_server(text, text) from public, anon;
grant execute on function public.is_member() to authenticated;
grant execute on function public.join_server(text, text) to authenticated;

-- ---------- Yetkiler (RLS) ----------

alter table public.profiles enable row level security;
alter table public.channels enable row level security;
alter table public.messages enable row level security;
alter table public.server_settings enable row level security;

grant select on public.profiles to authenticated;
grant select, insert on public.channels to authenticated;
grant select, insert, delete on public.messages to authenticated;

create policy "uyeler profilleri gorur" on public.profiles
  for select to authenticated using (public.is_member());

create policy "uyeler kanallari gorur" on public.channels
  for select to authenticated using (public.is_member());

create policy "uyeler kanal acar" on public.channels
  for insert to authenticated with check (public.is_member());

create policy "uyeler mesajlari gorur" on public.messages
  for select to authenticated using (public.is_member());

create policy "uyeler mesaj yazar" on public.messages
  for insert to authenticated
  with check (public.is_member() and user_id = (select auth.uid()));

create policy "kendi mesajini siler" on public.messages
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------- Realtime ----------

-- Yeni mesaj ve kanalların anlık gelmesi için.
alter publication supabase_realtime add table public.messages, public.channels;

-- Çevrimiçi listesi ve sesli sohbet sinyalleşmesi özel (private) kanaldan geçer;
-- yalnızca üyeler dinleyebilir ve gönderebilir.
create policy "uyeler dinler" on realtime.messages
  for select to authenticated using (public.is_member());

create policy "uyeler gonderir" on realtime.messages
  for insert to authenticated with check (public.is_member());

-- ---------- Başlangıç verisi ----------

insert into public.channels (name, kind) values
  ('genel', 'text'),
  ('Sohbet Odası', 'voice');

-- !!! BUNU DEĞİŞTİR: arkadaşlarına vereceğin davet kodu.
insert into public.server_settings (invite_code) values ('BURAYA-KENDI-KODUNU-YAZ');
