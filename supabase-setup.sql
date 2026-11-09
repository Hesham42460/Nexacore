-- إعداد قاعدة بيانات NexaCore ERP متعددة الشركات (Multi-Tenant & 200+ Users)
create table if not exists public.app_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tenant_id text not null default 'COMP-001',
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_app_data_tenant on public.app_data(tenant_id);

create or replace function public.app_data_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists app_data_touch on public.app_data;
create trigger app_data_touch before insert or update on public.app_data
for each row execute function public.app_data_touch();

alter table public.app_data enable row level security;

drop policy if exists "own row" on public.app_data;
create policy "own row" on public.app_data
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
