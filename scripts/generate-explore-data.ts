import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeGraph } from '@/lib/graphAnalysis';
import { buildGraph, crawlWikipedia, sanitizeGraphData } from '@/lib/crawler';
import type { ExploreGraphData } from '@/lib/exploreData';
import { validateExploreGraph } from '@/lib/exploreData';
import { exploreTopics, getExploreTopic } from '@/lib/exploreTopics';

const MAX_NODES = 24;
const CRAWL_DEPTH = 1;

async function generateTopic(slug: string): Promise<{ slug: string; nodeCount: number; edgeCount: number; partial: boolean }> {
  const topic = getExploreTopic(slug);
  if (!topic) throw new Error(`Unknown topic slug: ${slug}`);

  const crawled = await crawlWikipedia({
    seedTitle: topic.wikipediaTitle,
    depth: CRAWL_DEPTH,
    maxNodes: MAX_NODES,
  });
  const sanitized = sanitizeGraphData(crawled.nodes, crawled.edges);
  const graph = buildGraph(sanitized.nodes, sanitized.edges);
  const analysis = analyzeGraph(graph, crawled.seedId);
  const data: ExploreGraphData = {
    schemaVersion: 1,
    seedTitle: topic.wikipediaTitle,
    seedId: crawled.seedId,
    nodes: analysis.nodes.sort((left, right) => left.id.localeCompare(right.id, 'en')),
    edges: [...new Map(sanitized.edges.map((edge) => [`${edge.source}\u0000${edge.target}`, edge])).values()]
      .sort((left, right) => left.source.localeCompare(right.source, 'en') || left.target.localeCompare(right.target, 'en')),
    partial: crawled.partial,
    failedTitles: [...crawled.failedTitles].sort((left, right) => left.localeCompare(right, 'en')),
  };

  const issues = validateExploreGraph(data, topic);
  if (issues.length > 0) throw new Error(`Generated graph failed validation: ${issues.join(' ')}`);

  const outputDirectory = path.join(process.cwd(), 'data', 'explore');
  const outputPath = path.join(outputDirectory, `${slug}.json`);
  const temporaryPath = `${outputPath}.tmp`;
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
  await rename(temporaryPath, outputPath);

  return { slug, nodeCount: data.nodes.length, edgeCount: data.edges.length, partial: data.partial };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const requestedSlugs = args.filter((argument) => argument !== '--all');
  const targets = all
    ? exploreTopics.map(({ slug }) => slug)
    : requestedSlugs.length > 0
      ? requestedSlugs
      : ['black-holes'];

  const succeeded: Array<{ slug: string; nodeCount: number; edgeCount: number; partial: boolean }> = [];
  const failed: Array<{ slug: string; error: string }> = [];

  for (const slug of targets) {
    try {
      const result = await generateTopic(slug);
      succeeded.push(result);
      console.log(`OK ${slug}: ${result.nodeCount} pages, ${result.edgeCount} links${result.partial ? ' (partial crawl)' : ''}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ slug, error: message });
      console.error(`FAILED ${slug}: ${message}`);
    }
  }

  console.log(`Explore data generation finished: ${succeeded.length} succeeded, ${failed.length} failed.`);
  if (failed.length > 0) process.exitCode = 1;
}

void main();