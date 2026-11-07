---
name: seo
description: Bootstrap or audit SEO metadata, Open Graph tags, structured data (JSON-LD), sitemap, robots.txt, canonical URLs, social sharing previews, content strategy, and internal linking for any web project. Applies Product-Led SEO principles (Eli Schwartz). Use when the user says "add seo", "set up meta tags", "open graph", "og tags", "social sharing", "meta tags", "structured data", "json-ld", "schema markup", "sitemap", "robots.txt", "seo audit", "fix seo", "social preview", "twitter card", "rich snippets", "search optimization", "content strategy", "internal linking", "seo strategy", or when shipping a frontend that needs to be discoverable and shareable.
version: 0.2.0
---

# SEO & Metadata — Discoverable, Shareable, Indexable

You are setting up SEO and metadata for a web project. The goal: every page renders correctly in Google search results, looks great when shared on Twitter/LinkedIn/Slack/Discord, and provides structured data for rich snippets. This is not an afterthought — it ships with the feature.

## Product-Led SEO Philosophy (Eli Schwartz)

Before touching any meta tags, internalize these principles. They govern every decision below.

### Core Mindset

**SEO is a product discipline, not a marketing campaign.** You don't start with keyword tools — you start with customer research. Build pages/tools/content that provide genuine value to real users. Search traffic follows as a byproduct of creating something people actually need.

- **Blue Ocean > Red Ocean.** If anyone with a keyword tool can replicate your strategy, it's not defensible. Create content in categories that don't yet exist rather than competing on known keywords everyone targets.
- **SEO compounds.** Like compound interest — small consistent efforts beat big sporadic pushes. A site that generates traffic accrues positive signals (links, engagement) that compound into more traffic. Invest early and maintain.
- **Content is a tool, not a king.** Every piece must earn its keep through measurable results. Don't produce content for content's sake.
- **Write for users first, search engines second.** Google uses AI to mimic human judgment. If users love it, Google will follow.
- **Every SEO effort must have a direct path to revenue.** If you can't articulate the business case, don't build it.
- **Execution trumps strategy.** The #1 reason SEO fails is that plans never get implemented. Do something small today rather than planning the perfect strategy forever.

### Five Strategy Validation Questions

Before investing in any SEO product or content initiative, answer:
1. Is there something about your site/business that makes you uniquely able to build this?
2. Will it be difficult to copy because you did more than keyword research?
3. Are you targeting queries real humans would write?
4. Is there seemingly infinite growth potential without continuously reinvesting in content?
5. Can you justify the investment based on downstream revenue?

If you can't answer "yes" to at least 3 of these, reconsider the approach.

### Internal Linking: The Southwest Airlines Model

Internal linking architecture matters as much as content quality:

- **Bad (Singapore Airlines):** Hub-and-spoke from homepage only. Every page connects through one hub.
- **Common (United Airlines):** Multiple hubs, but limited pathways. Crawlers revisit the same hubs repeatedly.
- **Ideal (Southwest Airlines):** Point-to-point connections everywhere. Pages link to important pages AND random/diverse pages. A crawler can reach any page from any entry point.

Implementation:
- Use related page modules, random link modules, and recent content modules
- Build HTML sitemaps for large sites (every page linked from one place)
- Avoid algorithms that only surface popular content (reinforces existing winners, orphans everything else)
- No orphaned pages — every page must be reachable via internal links

### Content Strategy Principles

- Start with customer research, not keyword research. Talk to users, read support tickets, run surveys. Understand WHY people search, not just WHAT they search
- Programmatic, data-driven content at scale often beats manually written long-form content
- Pick one SEO product and go all-in. Don't split resources across multiple half-baked efforts
- Not every business needs a blog. Match content type to business model
- Match content depth to funnel position (long-form for awareness, short snippets for bottom-of-funnel)
- Match content format to device (mobile vs. desktop)
- Every piece of content should have a targeted CTA relevant to funnel position
- Write for real personas, not keywords. Start persona research before keyword research

### Measurement Framework

Three levels of SEO performance, in order:
1. **Impressions** — your page is in the consideration set (visible in search results)
2. **Clicks** — users choose to visit your page
3. **Conversions** — users take a desired action

Rules:
- **Google Search Console is the source of truth**, not third-party tools. It has real (not estimated) data on impressions, clicks, and queries
- Separate brand vs. non-brand traffic in all reporting. Brand traffic is NOT an SEO win
- Use the same KPIs as the rest of the business. Translate SEO wins into revenue terms
- Rankings are a vanity metric — don't use them as the primary KPI
- Build toward multi-touch attribution. At minimum, track micro-conversions from organic traffic
- SEO typically lives high in the funnel — it's an "assist," not the slam dunk. Last-click attribution massively undercredits organic search

### Common Mistakes to Avoid

- Starting with keyword research instead of customer research
- Writing content for Google instead of for users
- Chasing head terms that are too broad and competitive
- Panicking over algorithm updates — they're product improvements. If you serve users, updates help you
- Treating SEO as a campaign rather than a product investment
- Copying competitors' keyword strategy — not defensible
- Dabbling in multiple SEO products at once instead of going all-in on one
- Over-relying on content quantity over quality
- Neglecting internal linking — orphaned pages never get discovered
- Fear of duplicate content — there is no penalty, Google just picks a canonical

---

## Protocol

### Phase 0: Detect Mode

1. **Read the project** — Scan for existing meta tags, OG tags, sitemap, robots.txt, structured data
2. **Detect framework** — Vue (vue-router, @unhead/vue), React (react-helmet, next/head), Astro, plain HTML, etc.
3. **Detect rendering mode** — SPA (client-side only), SSR (Nuxt, Next, Remix), SSG (Astro, static), or hybrid
4. **Assess content architecture** — How are pages generated? Programmatic/data-driven or manual? What internal linking patterns exist?
5. **Choose mode:**
   - **Bootstrap** — No SEO setup exists → build from scratch
   - **Upgrade** — Partial setup exists → audit and fill gaps

**Critical SPA warning:** If the project is a client-side SPA without SSR/SSG, flag this immediately. Search engines and social crawlers cannot reliably execute JavaScript. Options:
- Add SSR/SSG (Nuxt for Vue, Next for React)
- Use a prerendering service (prerender.io, Rendertron)
- Accept that dynamic meta tags won't work for crawlers and use static fallbacks in `index.html`

### Phase 1: Core HTML Meta Tags

Every page needs these in `<head>`:

```html
<!-- Primary Meta Tags -->
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{Page Title} — {Site Name}</title>
<meta name="description" content="{150-160 char description with primary keywords}">
<link rel="canonical" href="{full canonical URL}">

<!-- Favicon -->
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">

<!-- Language -->
<meta http-equiv="content-language" content="en">
<html lang="en">
```

**Title formula:** `{Primary Keyword — Action/Benefit} | {Brand}`
- Homepage: `Beecon — Agent-Driven Infrastructure as Code | beecon.sh`
- Feature page: `Drift Detection — Catch Config Drift Before It Breaks Prod | Beecon`
- Blog post: `How to Automate Terraform with AI Agents — Beecon Blog`

**Description rules:**
- 150-160 characters (Google truncates beyond this)
- Include the primary keyword naturally — don't stuff
- Include a call to action or value prop
- Unique per page — never duplicate descriptions
- Write for humans. Google penalizes keyword stuffing

### Phase 2: Open Graph (Facebook, LinkedIn, Discord, Slack)

```html
<!-- Open Graph -->
<meta property="og:type" content="{website|article|product}">
<meta property="og:site_name" content="{Site Name}">
<meta property="og:title" content="{Page Title}">
<meta property="og:description" content="{Description — can be longer than meta description, up to 300 chars}">
<meta property="og:url" content="{canonical URL}">
<meta property="og:image" content="{absolute URL to image, min 1200x630px}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="{descriptive alt text}">
<meta property="og:locale" content="en_US">
```

**OG image requirements:**
- Minimum: 1200x630px (1.91:1 ratio) — this is the standard for all platforms
- Format: PNG or JPG, under 5MB
- Must be an absolute URL (not relative path)
- Should be visually meaningful even at thumbnail size (large text, clear branding)
- Create a default OG image for the site + per-page images for key pages

**For articles/blog posts, add:**
```html
<meta property="article:published_time" content="{ISO 8601 date}">
<meta property="article:modified_time" content="{ISO 8601 date}">
<meta property="article:author" content="{author name or URL}">
<meta property="article:tag" content="{tag1}">
<meta property="article:tag" content="{tag2}">
```

### Phase 3: Twitter Cards

```html
<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@{twitter_handle}">
<meta name="twitter:creator" content="@{author_handle}">
<meta name="twitter:title" content="{Title — max 70 chars}">
<meta name="twitter:description" content="{Description — max 200 chars}">
<meta name="twitter:image" content="{absolute URL to image}">
<meta name="twitter:image:alt" content="{alt text}">
```

**Card types:**
- `summary_large_image` — Full-width image card (best for most pages)
- `summary` — Small square thumbnail + text (for pages without strong visuals)

### Phase 4: Structured Data (JSON-LD)

Add JSON-LD structured data for rich snippets in search results. Google recommends JSON-LD over microdata — it's easier to maintain and doesn't pollute the HTML. Choose the appropriate schema type:

**Organization (homepage):**
```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "{Company Name}",
  "url": "{site URL}",
  "logo": "{logo URL}",
  "description": "{company description}",
  "sameAs": [
    "https://twitter.com/{handle}",
    "https://github.com/{org}",
    "https://linkedin.com/company/{slug}"
  ]
}
</script>
```

**SoftwareApplication (for tools/products):**
```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "{App Name}",
  "description": "{description}",
  "url": "{app URL}",
  "applicationCategory": "{category, e.g., DeveloperApplication}",
  "operatingSystem": "macOS, Linux",
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "USD"
  }
}
</script>
```

**Article/BlogPosting (for content pages):**
```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "{title}",
  "description": "{description}",
  "author": {
    "@type": "Person",
    "name": "{author}"
  },
  "datePublished": "{ISO date}",
  "dateModified": "{ISO date}",
  "image": "{image URL}",
  "publisher": {
    "@type": "Organization",
    "name": "{org name}",
    "logo": {
      "@type": "ImageObject",
      "url": "{logo URL}"
    }
  }
}
</script>
```

**BreadcrumbList (for sites with navigation hierarchy):**
```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Home", "item": "{base URL}" },
    { "@type": "ListItem", "position": 2, "name": "{Section}", "item": "{section URL}" },
    { "@type": "ListItem", "position": 3, "name": "{Page}", "item": "{page URL}" }
  ]
}
</script>
```

**FAQPage (for pages with Q&A content):**
```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "{question}",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "{answer}"
      }
    }
  ]
}
</script>
```

### Phase 5: Technical SEO Files

#### `robots.txt`
```
User-agent: *
Allow: /

# Block non-public paths
Disallow: /api/
Disallow: /admin/
Disallow: /auth/
Disallow: /_next/  # or /_nuxt/ for Nuxt

Sitemap: https://{domain}/sitemap.xml
```

**Crawl budget considerations:**
- Think of crawl budget as Google's financial budget for crawling your site
- More authoritative sites get more budget
- Block low-quality pages from crawlers so budget is spent on valuable content
- Use noindex, canonical tags, and robots.txt strategically
- JavaScript-heavy pages consume more crawl budget

#### `sitemap.xml`

For static sites, generate at build time. For dynamic sites, generate on request or via cron.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://{domain}/</loc>
    <lastmod>{ISO date}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://{domain}/features</loc>
    <lastmod>{ISO date}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>
```

**Framework-specific sitemap generation:**
- **Nuxt**: `@nuxtjs/sitemap` module (automatic)
- **Next.js**: `next-sitemap` package or `app/sitemap.ts`
- **Astro**: `@astrojs/sitemap` integration
- **Vue SPA**: Generate at build time with a script, or use `vite-plugin-sitemap`

### Phase 6: Internal Linking Audit

After setting up meta tags and technical SEO, audit the internal linking architecture:

1. **Map the link graph** — Identify how pages connect to each other
2. **Find orphaned pages** — Pages with no internal links pointing to them
3. **Check for hub-and-spoke patterns** — Restructure toward point-to-point (Southwest model)
4. **Verify cross-linking** — Every content page should link to 5-8 other internal pages naturally in prose
5. **Add related content modules** — Programmatic "related pages" blocks at the bottom of content
6. **Check for dead ends** — Pages that don't link out to anything else on the site
7. **Validate link diversity** — Don't always link to the same popular pages. Include links to newer/deeper content

### Phase 7: Framework Integration

Wire the meta tags into the framework's head management system:

**Vue 3 + @unhead/vue (or vue-meta):**
```typescript
// composables/useSeo.ts
import { useHead } from '@unhead/vue'

interface SeoOptions {
  title: string
  description: string
  image?: string
  url?: string
  type?: 'website' | 'article'
}

export function useSeo(options: SeoOptions) {
  const siteName = 'Your App'
  const baseUrl = 'https://yourapp.com'
  const defaultImage = `${baseUrl}/og-default.png`

  useHead({
    title: `${options.title} | ${siteName}`,
    meta: [
      { name: 'description', content: options.description },
      { property: 'og:type', content: options.type ?? 'website' },
      { property: 'og:site_name', content: siteName },
      { property: 'og:title', content: options.title },
      { property: 'og:description', content: options.description },
      { property: 'og:url', content: options.url ?? baseUrl },
      { property: 'og:image', content: options.image ?? defaultImage },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: options.title },
      { name: 'twitter:description', content: options.description },
      { name: 'twitter:image', content: options.image ?? defaultImage },
    ],
    link: [
      { rel: 'canonical', href: options.url ?? baseUrl },
    ],
  })
}
```

**React + react-helmet / Next.js:**
```typescript
// components/Seo.tsx
import { Helmet } from 'react-helmet-async'

interface SeoProps {
  title: string
  description: string
  image?: string
  url?: string
  type?: 'website' | 'article'
}

export function Seo({ title, description, image, url, type = 'website' }: SeoProps) {
  const siteName = 'Your App'
  const baseUrl = 'https://yourapp.com'
  const ogImage = image ?? `${baseUrl}/og-default.png`
  const fullTitle = `${title} | ${siteName}`

  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={url ?? baseUrl} />
      <meta property="og:type" content={type} />
      <meta property="og:site_name" content={siteName} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url ?? baseUrl} />
      <meta property="og:image" content={ogImage} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={ogImage} />
    </Helmet>
  )
}
```

**For Next.js App Router**, use the `metadata` export or `generateMetadata()` instead of react-helmet.

**Plain HTML / Static sites:**
Add the tags directly to each HTML file's `<head>`. If using a templating system, create a partial/include.

### Phase 8: Audit Mode (Upgrade)

If SEO already exists, audit against every section above and produce a gap report:

```
## SEO Audit

### Current State
- Meta tags: {present/missing/incomplete}
- Open Graph: {present/missing/incomplete}
- Twitter Cards: {present/missing/incomplete}
- Structured Data: {present/missing/incomplete}
- robots.txt: {present/missing}
- sitemap.xml: {present/missing}
- Canonical URLs: {present/missing}
- Rendering: {SPA/SSR/SSG — crawler-friendly?}
- Internal linking: {Southwest/United/Singapore model?}
- Content strategy: {user-driven/keyword-driven/none?}

### Gaps Found

#### [CRITICAL/HIGH/MEDIUM/LOW] {Gap title}
- **Current:** {what exists}
- **Required:** {what should exist}
- **Fix:** {exact change}
- **Files:** {affected files}

### Validation
- [ ] Google Rich Results Test: {pass/fail}
- [ ] Facebook Sharing Debugger: {pass/fail}
- [ ] Twitter Card Validator: {pass/fail}
- [ ] Lighthouse SEO score: {score}/100
- [ ] Google Search Console: {connected/not connected}
- [ ] Internal linking: no orphaned pages
- [ ] Crawl budget: low-quality pages blocked
```

### Phase 9: Verify

After bootstrap or upgrade:

1. **Validate structured data** — Check JSON-LD is valid JSON and uses correct schema.org types
2. **Check image URLs** — All OG/Twitter images must be absolute URLs that resolve
3. **Check title/description lengths** — Titles under 60 chars, descriptions 150-160 chars
4. **Check canonical URLs** — Must be absolute, must match the actual page URL
5. **Test social previews** — Mention the testing tools:
   - Facebook: https://developers.facebook.com/tools/debug/
   - Twitter: https://cards-dev.twitter.com/validator
   - LinkedIn: https://www.linkedin.com/post-inspector/
   - General: https://www.opengraph.xyz/
6. **Check robots.txt** — Verify it doesn't accidentally block important pages
7. **Validate sitemap** — Verify all listed URLs return 200
8. **Audit internal links** — No orphaned pages, no dead ends, diverse link targets
9. **Verify Google Search Console** — Recommend connecting if not already set up

## Rules

### Technical Rules
- **Absolute URLs everywhere.** OG images, canonical links, sitemap entries — always full URLs with protocol and domain. Relative paths break sharing and indexing.
- **Unique per page.** Every page gets its own title, description, OG tags, and canonical URL. Duplicate metadata across pages hurts SEO.
- **Image matters most.** The OG image is 80% of what determines whether someone clicks a shared link. Make it good — clear branding, readable text, high contrast.
- **SPA = invisible to crawlers.** If the project is a client-side SPA, social sharing previews will only show what's in the static `index.html`. Either add SSR/prerendering or accept this limitation.
- **Canonical is mandatory.** Every page needs a canonical URL. Without it, search engines may index duplicate content (www vs non-www, trailing slashes, query params).
- **JSON-LD over microdata.** Google recommends JSON-LD for structured data. It's easier to maintain and doesn't pollute the HTML.
- **Test before shipping.** Use the social preview tools to verify how links will actually look when shared. Screenshots from the debugger are proof it works.
- **Use 301 redirects for URL changes.** Never 302. Map every old URL to new. Maintain redirects permanently.
- **Manage crawl budget.** Block low-quality pages so Google spends its crawl budget on valuable content.

### Strategic Rules (Product-Led SEO)
- **Don't keyword stuff.** Write descriptions for humans. Natural language with one or two keywords is optimal.
- **Build for users, not for Google.** Google's algorithm mimics human judgment. If users love it, Google will follow.
- **No content without purpose.** Every page must have a measurable reason to exist — traffic, conversions, or internal linking value.
- **Internal linking is as important as content.** Use the Southwest Airlines model: point-to-point connections, no orphaned pages, diverse link targets.
- **Don't fear duplicate content.** There is no duplicate content penalty. Google just picks a canonical version. Don't waste effort spinning content — add genuine value instead.
- **Don't panic over algorithm updates.** They're product improvements. If you serve users, updates help you.
- **Measure with Google Search Console.** It's the only source of true visibility data. Trust it over any third-party tool.
- **Separate brand vs. non-brand traffic.** Brand traffic is not an SEO win — track non-brand organic growth as the real indicator.
- **Your moat is complexity.** The harder your SEO product is to replicate (unique data, proprietary tools, genuine expertise), the more durable your position.
