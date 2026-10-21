import fs from 'node:fs';
import path from 'node:path';

import type { Core } from '@strapi/strapi';

/** 档案数据使用的两种语言（与前端 vue-i18n 的 zh / en 对应） */
const LOCALES = [
  { code: 'en-US', name: 'English (United States)' },
  { code: 'zh-CN', name: 'Chinese (Simplified, China)' },
];

/** 基准语言：每条数据先以该语言创建，再挂上其它语言的 localization */
const BASE_LOCALE = 'en-US';

/** 需要从 `scripts/seed-content.json` 播种的集合 */
const COLLECTIONS = [
  { key: 'projects', uid: 'api::project.project' },
  { key: 'pulses', uid: 'api::pulse.pulse' },
  { key: 'blogPosts', uid: 'api::blog-post.blog-post' },
] as const;

/** 开放给未登录访客的只读接口 */
const PUBLIC_ACTIONS = COLLECTIONS.flatMap(({ uid }) => [`${uid}.find`, `${uid}.findOne`]);

const SEED_FILE = path.join(process.cwd(), 'scripts', 'seed-content.json');

interface SeedRecord {
  slug: string;
  base: Record<string, unknown>;
  locales: Record<string, Record<string, unknown>>;
}

interface SeedPayload {
  projects: SeedRecord[];
  pulses: SeedRecord[];
  blogPosts: SeedRecord[];
}

/**
 * 文档服务是按运行时 UID 分发的，而新增内容类型此刻尚未写进自动生成的 TS 类型里，
 * 因此这里收敛成一个小接口，避免在调用处散落类型断言。
 */
type DocumentRepository = {
  create(params: Record<string, unknown>): Promise<{ documentId: string }>;
  findFirst(params: Record<string, unknown>): Promise<{ documentId: string } | null>;
};

const getRepository = (strapi: Core.Strapi, uid: string): DocumentRepository =>
  (strapi.documents as unknown as (uid: string) => DocumentRepository)(uid);

/** 确保 Strapi 里存在需要的语言 */
const ensureLocales = async (strapi: Core.Strapi) => {
  const locales = strapi.plugin('i18n').service('locales');

  const existing = await locales.find();
  const existingCodes = new Set(existing.map((locale: { code: string }) => locale.code));

  for (const locale of LOCALES) {
    if (!existingCodes.has(locale.code)) {
      await locales.create(locale);
      strapi.log.info(`[archive-seed] 新增语言 ${locale.code}`);
    }
  }

  // 基准语言就是默认语言，这样不带 locale 参数的请求也能拿到数据
  await locales.setDefaultLocale({ code: BASE_LOCALE });
};

/** 开放公共读权限（幂等：已存在的权限不会重复创建） */
const ensurePublicPermissions = async (strapi: Core.Strapi) => {
  const publicRole = await strapi.db
    .query('plugin::users-permissions.role')
    .findOne({ where: { type: 'public' } });

  if (!publicRole) {
    strapi.log.warn('[archive-seed] 未找到 public 角色，跳过公共读权限配置');
    return;
  }

  const granted = await strapi.db
    .query('plugin::users-permissions.permission')
    .findMany({ where: { role: publicRole.id, action: { $in: PUBLIC_ACTIONS } } });

  const grantedActions = new Set(granted.map((permission: { action: string }) => permission.action));

  for (const action of PUBLIC_ACTIONS) {
    if (!grantedActions.has(action)) {
      await strapi.db
        .query('plugin::users-permissions.permission')
        .create({ data: { action, role: publicRole.id } });
    }
  }
};

/**
 * 播种一个集合。
 *
 * 每条数据先在基准语言创建主记录（documentId 由 Strapi 生成），再以该 documentId
 * 建立其它语言的 localization。注意：文档服务的 `create` 不会替我们补齐非本地化字段
 * （`copyNonLocalizedFields` 只在 publish 路径上被调用），所以每次创建都必须把 base 带上。
 *
 * 按 (slug, locale) 逐条判存，因此重复执行、中断后重跑都不会产生脏数据。
 */
const seedCollection = async (strapi: Core.Strapi, uid: string, records: SeedRecord[]) => {
  const repository = getRepository(strapi, uid);

  let created = 0;

  for (const record of records) {
    let base = await repository.findFirst({
      filters: { slug: record.slug },
      locale: BASE_LOCALE,
    });

    if (!base) {
      base = await repository.create({
        data: { ...record.base, ...record.locales[BASE_LOCALE] },
        locale: BASE_LOCALE,
        status: 'published',
      });
      created += 1;
    }

    for (const [locale, localizedData] of Object.entries(record.locales)) {
      if (locale === BASE_LOCALE) continue;

      const existing = await repository.findFirst({
        filters: { slug: record.slug },
        locale,
      });

      if (existing) continue;

      await repository.create({
        data: { ...record.base, ...localizedData, documentId: base.documentId },
        locale,
        status: 'published',
      });
      created += 1;
    }
  }

  return created;
};

/** 读取导出的种子文件；不存在时只提示、不阻塞启动 */
const readSeedPayload = (strapi: Core.Strapi): SeedPayload | null => {
  if (!fs.existsSync(SEED_FILE)) {
    strapi.log.warn('[archive-seed] 未找到 scripts/seed-content.json，请先执行：node scripts/export-seed.mjs');
    return null;
  }

  return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) as SeedPayload;
};

const seedContent = async (strapi: Core.Strapi) => {
  const payload = readSeedPayload(strapi);
  if (!payload) return;

  for (const collection of COLLECTIONS) {
    const records = payload[collection.key] ?? [];
    const created = await seedCollection(strapi, collection.uid, records);
    strapi.log.info(`[archive-seed] ${collection.key}: 新建 ${created} / ${records.length} 条记录`);
  }
};

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await ensureLocales(strapi);
    await ensurePublicPermissions(strapi);
    await seedContent(strapi);
  },
};
