export interface LearnSection {
  heading: string;
  paragraphs: string[];
}

export interface LearnArticle {
  slug: string;
  title: string;
  description: string;
  intro: string;
  sections: LearnSection[];
  relatedTopics: string[];
}

export const learnArticles: LearnArticle[] = [
  {
    slug: 'what-is-a-wikipedia-rabbit-hole',
    title: 'What Is a Wikipedia Rabbit Hole?',
    description: 'A Wikipedia rabbit hole is a chain of curiosity driven by links between articles. Learn how to follow one without losing the thread.',
    intro: 'A Wikipedia rabbit hole begins with one question and grows through links that reveal adjacent ideas, people, events, and fields. The route is personal: two readers starting on the same page can follow entirely different trails.',
    sections: [
      { heading: 'Links make curiosity navigable', paragraphs: [
        'A Wikipedia article is not an isolated essay. Inline links and navigation sections point to other articles, so a question about one topic can lead to its context, history, or a concept from another discipline.',
        'The useful part is often the transition: a link makes one relationship visible, while the destination offers a new set of questions. Following links is a way to browse, not a ranking of what matters most.',
      ] },
      { heading: 'A graph gives the trail a shape', paragraphs: [
        'A graph represents articles as nodes and article links as directed edges. Looking at several hops at once can make clusters and bridges easier to notice than opening pages one by one.',
        'WikiCrawl builds a bounded sample from a chosen starting article. The map describes only the pages and links included in that crawl, not all of Wikipedia.',
      ] },
      { heading: 'Start with a question', paragraphs: [
        'Choose a subject you already wonder about, then follow the pages that answer a new question. WikiCrawl’s curated starting points include [[black-holes|black holes]], [[ancient-rome|Ancient Rome]], and [[artificial-intelligence|artificial intelligence]].',
      ] },
    ],
    relatedTopics: ['black-holes', 'ancient-rome', 'artificial-intelligence'],
  },
  {
    slug: 'wikipedia-knowledge-graph',
    title: 'Wikipedia as a Knowledge Graph',
    description: 'See how Wikipedia articles and their links can be represented as a graph, and what that view can and cannot tell you.',
    intro: 'A knowledge graph makes entities and their connections explicit. For Wikipedia, an article can be represented as a node and a link from one article to another as a directed edge.',
    sections: [
      { heading: 'Nodes and directed links', paragraphs: [
        'In a Wikipedia link graph, each node is an article page. If article A links to article B, the graph contains a directed edge from A to B. The reverse edge exists only if B also links back to A.',
        'This model is useful for exploring navigation structure. It does not by itself prove that two ideas have a particular semantic relationship; it records a link between pages.',
      ] },
      { heading: 'A sampled graph is not the whole encyclopedia', paragraphs: [
        'Wikipedia contains far more articles and links than a typical interactive view should load at once. A crawler therefore chooses a starting page, follows links to a limited depth, and applies a page limit.',
        'Metrics such as PageRank, betweenness, or community assignments describe the sampled subgraph being analyzed. A different starting article or limit can produce a different structure.',
      ] },
      { heading: 'Explore a topic map', paragraphs: [
        'WikiCrawl can map articles around [[quantum-mechanics|quantum mechanics]], [[climate-change|climate change]], or [[astronomy|astronomy]]. The interactive graph preserves link direction and lets you inspect pages and their positions in the current sample.',
      ] },
    ],
    relatedTopics: ['quantum-mechanics', 'climate-change', 'astronomy'],
  },
  {
    slug: 'how-wikipedia-articles-are-connected',
    title: 'How Wikipedia Articles Are Connected',
    description: 'Understand the links that connect Wikipedia articles and how an article-link graph differs from a semantic knowledge base.',
    intro: 'Wikipedia articles connect through links added by editors. Those links help readers move through context, but they do not all mean the same thing: a link may point to a definition, a person, a place, or a related subject.',
    sections: [
      { heading: 'A link is evidence of navigation', paragraphs: [
        'A link from one page to another is a concrete, inspectable connection in the encyclopedia. Treating it as a directed edge preserves which page contains the link.',
        'The edge alone does not specify why the destination matters. A link graph is therefore different from a knowledge base that assigns typed facts such as “born in” or “causes.”',
      ] },
      { heading: 'Sampling affects what you see', paragraphs: [
        'A graph explorer cannot show every Wikipedia page at once. It samples a neighborhood around a seed article according to its depth and size limits. Links between pages outside that sample cannot appear in the resulting map.',
        'WikiCrawl’s traversal batches MediaWiki link requests, resolves redirects, filters noisy titles, and observes an explicit request budget. The graph analysis runs over the pages it successfully gathered.',
      ] },
      { heading: 'Follow one neighborhood', paragraphs: [
        'Compare the article neighborhoods around [[gravitational-waves|gravitational waves]] and [[space-exploration|space exploration]], then change the crawl settings in the live graph to examine a broader or narrower sample.',
      ] },
    ],
    relatedTopics: ['gravitational-waves', 'space-exploration', 'general-relativity'],
  },
  {
    slug: 'how-wikicrawl-works',
    title: 'How WikiCrawl Works',
    description: 'A practical account of WikiCrawl’s MediaWiki requests, bounded crawling, graph analysis, and interactive rendering.',
    intro: 'WikiCrawl searches for a Wikipedia starting article, retrieves linked pages in bounded batches, analyzes the resulting subgraph, and streams the graph to a browser-based explorer.',
    sections: [
      { heading: 'Search and bounded crawling', paragraphs: [
        'The browser search uses Wikipedia’s OpenSearch API. When a crawl starts, the server validates the seed through MediaWiki and calls WikiCrawl’s existing crawler, which fetches article links in batches and follows continuation tokens.',
        'The crawl has configurable depth and page limits, a maximum of three concurrent crawl workers, ten-second link request timeouts, and an upper bound of 500 traversal requests. Layer-one pageviews can prioritize candidates; a seed-based hash provides a deterministic fallback when views are unavailable.',
      ] },
      { heading: 'Graph analysis and live updates', paragraphs: [
        'The crawler returns article nodes and directed links. Graphology calculates PageRank and betweenness centrality and applies Louvain community detection to the sampled graph. Those values describe that crawl, not Wikipedia as a whole.',
        'The crawl route streams nodes, edges, progress, and final analysis through server-sent events. The client applies these updates incrementally to the graph shown by Sigma, while ForceAtlas2 positions nodes in a worker.',
      ] },
      { heading: 'Inspecting and expanding a map', paragraphs: [
        'Selecting a page opens its summary and graph metrics. Relationship context is fetched only when a user inspects a connection; WikiCrawl checks the source article’s wikitext and presents its rule-based interpretation separately from the source passage.',
        'Expanding a selected page makes a separate bounded crawl and merges its result. Shortest paths are calculated among the currently loaded pages and treat connections as undirected, even though displayed crawl links retain their direction.',
      ] },
      { heading: 'Try a curated starting point', paragraphs: [
        'Start with [[machine-learning|machine learning]], [[black-holes|black holes]], or browse the full [[explore|curated topic index]]. The SEO topic pages are static editorial pages; opening the live graph is what initiates a crawl.',
      ] },
    ],
    relatedTopics: ['machine-learning', 'black-holes'],
  },
];

export function getLearnArticle(slug: string): LearnArticle | undefined {
  return learnArticles.find((article) => article.slug === slug);
}