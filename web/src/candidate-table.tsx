import type { Entity } from "./api";
import { useApp } from "./state";
import { DataTable } from "./ui";
import { rankedCandidates } from "./trace-model";

export function CandidateTable({candidates, openCandidate}: {
  candidates: Entity[];
  openCandidate: (id: string) => void;
}) {
  const { t } = useApp();
  const selected = candidates.filter(candidate => candidate.selected).length;
  const reason = (candidate: Entity) => {
    if (candidate.selected) return t("已选为总结来源", "Selected as answer evidence");
    if (candidate.selection_reason === "source_limit") return t("相关，超出来源数量上限", "Relevant, beyond the source limit");
    if (candidate.relevant === false) return t("与问题不相关", "Not relevant to the question");
    return t("未取得有效评分", "No valid score received");
  };
  return (
    <section className="candidate-scoring">
      <p className="muted">
        {t("本次请求共", "This request has ")} {candidates.length} {t("个候选，已选中", "candidates, with ")} {selected} {t("个来源。已选项优先，各组内按评分从高到低排列。", "sources selected. Selected sources appear first, with each group sorted by score.")}
      </p>
      <DataTable>
        <DataTable.Header>
          {[t("选材结果", "Selection"), t("网页", "Page"), t("评分", "Score"),
            t("相关性", "Relevance"), t("选材说明", "Selection reason")].map(label =>
            <DataTable.Column key={label}>{label}</DataTable.Column>)}
        </DataTable.Header>
        <DataTable.Body>
          {rankedCandidates(candidates).map(candidate => (
            <DataTable.Row key={candidate.candidate_id} data-evidence-selected={!!candidate.selected}>
              <DataTable.Cell>
                <span className={candidate.selected ? "candidate-selected" : "muted"}>
                  {candidate.selected ? t("已选中", "Selected") : t("未选中", "Not selected")}
                </span>
              </DataTable.Cell>
              <DataTable.Cell>
                <button className="row-link" onClick={() => openCandidate(candidate.candidate_id)}>
                  {candidate.title || candidate.url || candidate.candidate_id}
                </button>
                {candidate.url && <small className="row-sub source-address" title={candidate.url}>{candidate.url}</small>}
              </DataTable.Cell>
              <DataTable.Cell><strong>{candidate.score == null ? "—" : candidate.score + " / 100"}</strong></DataTable.Cell>
              <DataTable.Cell>{candidate.relevant == null ? t("未评分", "Unscored") : candidate.relevant ? t("相关", "Relevant") : t("不相关", "Irrelevant")}</DataTable.Cell>
              <DataTable.Cell>{reason(candidate)}</DataTable.Cell>
            </DataTable.Row>
          ))}
        </DataTable.Body>
      </DataTable>
    </section>
  );
}
