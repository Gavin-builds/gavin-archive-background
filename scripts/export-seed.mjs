/**
 * 把前端 `gavin-archive/src/data/*.ts` 中的静态数据导出为后端可用的双语种子文件。
 *
 * 前端数据以 `{ zh, en }`（LocalizedText）内联双语，而 Strapi 官方 i18n 插件要求
 * 「一条记录 = 一种语言」。因此这里把每条数据拆成：
 *   - base：非本地化字段（各语言共享）
 *   - locales：{ 'zh-CN': {...}, 'en-US': {...} } 本地化字段
 *
 * 用法：npm run seed:export（可选工具，不是启动前置步骤）
 * 产物：scripts/seed-content.json（已提交到仓库，是 src/index.ts 播种的默认数据源）
 *
 * 前端的数据文件是 TypeScript，这里用项目自带的 typescript 编译器把它们转成临时
 * ESM 再动态 import（这些文件只包含 `import type` 与类型注解，转译后不残留任何导入，
 * 因此不会去解析前端的 tsconfig 与路径别名）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 前端数据目录，可用 FRONTEND_DATA_DIR 覆盖 */
const dataDir = process.env.FRONTEND_DATA_DIR
  ? path.resolve(process.env.FRONTEND_DATA_DIR)
  : path.resolve(here, '../../gavin-archive/src/data')

const outputFile = path.join(here, 'seed-content.json')

/** Strapi 侧使用的语言代码 */
const LOCALES = [
  ['zh-CN', 'zh'],
  ['en-US', 'en'],
]

const loadData = async (moduleName, exportName) => {
  const sourceFile = path.join(dataDir, `${moduleName}.ts`)

  if (!fs.existsSync(sourceFile)) {
    throw new Error(`找不到前端数据文件：${sourceFile}`)
  }

  const { outputText } = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourceFile,
  })

  const tempFile = path.join(os.tmpdir(), `archive-seed-${moduleName}-${process.pid}.mjs`)
  fs.writeFileSync(tempFile, outputText, 'utf8')

  try {
    const mod = await import(pathToFileURL(tempFile).href)
    const value = mod[exportName]

    if (!Array.isArray(value)) {
      throw new Error(`无法从 ${moduleName}.ts 读取 ${exportName} 数组`)
    }

    return value
  } finally {
    fs.rmSync(tempFile, { force: true })
  }
}

/** 取 LocalizedText 的某一语言；缺失时返回 undefined（JSON 序列化会自动丢弃） */
const pick = (value, lang) => (value == null ? undefined : value[lang])
/** 取 LocalizedText[] 的某一语言 */
const pickList = (list, lang) => (list == null ? undefined : list.map((item) => item[lang]))

// ---------------------------------------------------------------- project

const projectBase = (p) => ({
  slug: p.slug,
  stage: p.status,
  categories: p.categories,
  stack: p.stack,
  featured: p.featured,
  github: p.github,
  demo: p.demo,
  cover: p.cover,
  accent: p.accent,
  date: p.date,
})

const projectLocale = (p, lang) => ({
  title: pick(p.title, lang),
  description: pick(p.description, lang),
  context: pick(p.context, lang),
  role: pick(p.role, lang),
  problem: pick(p.problem, lang),
  solution: pick(p.solution, lang),
  tags: pickList(p.tags, lang),
  features: pickList(p.features, lang),
  highlights: pickList(p.highlights, lang),
  architecture: p.architecture?.map((node) => ({
    label: pick(node.label, lang),
    description: pick(node.description, lang),
  })),
  developmentLog: p.developmentLog?.map((entry) => ({
    date: entry.date,
    title: pick(entry.title, lang),
    description: pick(entry.description, lang),
  })),
  engineeringChallenges: p.engineeringChallenges?.map((item) => ({
    title: pick(item.title, lang),
    problem: pick(item.problem, lang),
    solution: pick(item.solution, lang),
  })),
})

// ---------------------------------------------------------------- pulse

const pulseBase = (p) => ({
  slug: p.slug,
  category: p.category,
  stage: p.status,
  date: p.date,
  lastActive: p.lastActive,
  activityCount: p.activityCount,
  relatedProject: p.relatedProject,
})

const pulseLocale = (p, lang) => ({
  title: pick(p.title, lang),
  subtitle: pick(p.subtitle, lang),
  tags: pickList(p.tags, lang),
  source: pick(p.source, lang),
  progress: pick(p.progress, lang),
  thought: pick(p.thought, lang),
  nextStep: pick(p.nextStep, lang),
})

// ---------------------------------------------------------------- blog

const blogBase = (b) => ({
  slug: b.slug,
  date: b.date,
  readTime: b.readTime,
  type: b.type,
  pinned: b.pinned,
  relatedProjects: b.relatedProjects,
  cover: b.cover,
})

const blogLocale = (b, lang) => ({
  title: pick(b.title, lang),
  description: pick(b.description, lang),
  tags: pickList(b.tags, lang),
  content: pickList(b.content, lang),
})

// ---------------------------------------------------------------- 组装

const buildRecords = (items, baseOf, localeOf) =>
  items.map((item) => ({
    slug: item.slug,
    base: baseOf(item),
    locales: Object.fromEntries(LOCALES.map(([strapiLocale, lang]) => [strapiLocale, localeOf(item, lang)])),
  }))

const main = async () => {
  const [projects, pulseItems, blogPosts] = await Promise.all([
    loadData('projects', 'projects'),
    loadData('pulse', 'pulseItems'),
    loadData('blog', 'blogPosts'),
  ])

  const payload = {
    generatedAt: new Date().toISOString(),
    source: dataDir,
    projects: buildRecords(projects, projectBase, projectLocale),
    pulses: buildRecords(pulseItems, pulseBase, pulseLocale),
    blogPosts: buildRecords(blogPosts, blogBase, blogLocale),
  }

  fs.writeFileSync(outputFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  console.log(
    `[export-seed] 已生成 ${path.relative(process.cwd(), outputFile)}：` +
      `projects=${payload.projects.length}, pulses=${payload.pulses.length}, blogPosts=${payload.blogPosts.length}`,
  )
}

main().catch((error) => {
  console.error('[export-seed] 导出失败：', error)
  process.exit(1)
})
