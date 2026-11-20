import { executionRoute, httpOf, mergedMatches, rankArticles, runDemo, type Command } from './engine';
import type { Config, Endpoint, Envelope, Lang, Op, Project } from './model';
import {
  dispatchPool, EndpointDispatch, offlineOutcome, type DispatchAttempt, type EndpointOutcome,
} from './routing';
import { checkRewriteContext, rewriteJob, sampleVariants } from './rewrite';

// Only the playground executes adapter fixtures. Route previews and diagnostic projections never dispatch.
export function executeDemo(
  op: Op,
  input: Command,
  project: Project,
  cfg: Config,
  id: string,
  uiLang: Lang,
  runtime: EndpointDispatch,
  send: (endpoint: Endpoint) => EndpointOutcome = offlineOutcome,
) {
  const route = executionRoute(project, cfg, input, runtime);
  const attempts: DispatchAttempt[] = [];
  const finish = (response: Envelope) => ({ response, route, attempts });
  const preview = runDemo(op, input, project, cfg, id, uiLang, route);
  if ([400, 503].includes(httpOf(preview))) return finish(preview);

  const language = input.language ?? project.language;
  if (op === 'content') {
    route.reader = dispatchPool(cfg, project, 'reader', language, undefined, runtime, input.url!, attempts, send);
    route.resources.reader = route.reader.id;
    return finish(runDemo(op, input, project, cfg, id, uiLang, route));
  }

  const query = input.query!.trim();
  const context = checkRewriteContext(input);
  const rewrite = op === 'summary' && context.ok
    ? rewriteJob(query, language, project.rewriteCount, context.value)
    : undefined;
  const queries = [query, ...sampleVariants(rewrite)];
  const inlineArticles = new Set<string>();
  for (const [index, target] of queries.entries()) {
    const choice = dispatchPool(cfg, project, 'search', language, input.time_range, runtime, target, attempts, send);
    if (index === 0 || !choice.id) {
      route.search = choice;
      route.resources.search = choice.id;
    }
    if (!choice.id) return finish(runDemo(op, input, project, cfg, id, uiLang, route));
    if (cfg.endpoints.find((e) => e.id === choice.id)?.adapter === 'integrated_search') {
      for (const { article } of rankArticles(target, input.time_range).slice(0, project.searchLimit))
        if (!article.snippetOnly) inlineArticles.add(article.url);
    }
  }
  if (op === 'list') return finish(runDemo(op, input, project, cfg, id, uiLang, route));

  const sources = mergedMatches(queries, input.time_range, project.searchLimit)
    .slice(0, input.source_count ?? project.sourceLimit);
  const unavailableBodies = new Set<string>();
  let firstReader = true;
  for (const { article } of sources) {
    if (inlineArticles.has(article.url)) continue;
    const choice = dispatchPool(cfg, project, 'reader', language, undefined, runtime, article.url, attempts, send);
    if (!choice.id) {
      unavailableBodies.add(article.url);
    } else if (firstReader) {
      firstReader = false;
      route.reader = choice;
      route.resources.reader = choice.id;
    }
  }
  return finish(runDemo(op, input, project, cfg, id, uiLang, route, unavailableBodies));
}
