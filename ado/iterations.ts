// PR metadata + iteration bookkeeping.
// Each push to the source branch creates a new iteration; $compareTo turns
// "changes in the whole PR" into "changes since the iteration I last reviewed".
import { adoGet, prBase, type AdoList } from "./client";
import type { ChangeEntry, ChangeType, Iteration, PrInfo, PrRef } from "../libs/types";

interface RawPr {
  title?: string;
  description?: string;
  sourceRefName?: string;
  targetRefName?: string;
  createdBy?: { displayName?: string };
  status?: string;
}

export async function getPrInfo(ref: PrRef): Promise<PrInfo> {
  const pr = await adoGet<RawPr>(prBase(ref));
  const short = (r?: string) => (r ?? "").replace(/^refs\/heads\//, "");
  return {
    title: pr.title ?? "",
    description: pr.description ?? "",
    sourceBranch: short(pr.sourceRefName),
    targetBranch: short(pr.targetRefName),
    createdBy: pr.createdBy?.displayName ?? "",
    status: pr.status ?? "",
  };
}

interface RawIteration {
  id?: number;
  sourceRefCommit?: { commitId?: string };
  targetRefCommit?: { commitId?: string };
  commonRefCommit?: { commitId?: string };
  createdDate?: string;
}

export async function listIterations(ref: PrRef): Promise<Iteration[]> {
  const res = await adoGet<AdoList<RawIteration>>(`${prBase(ref)}/iterations`);
  return (res.value ?? []).map((it) => ({
    id: it.id ?? 0,
    sourceRefCommit: it.sourceRefCommit?.commitId ?? "",
    targetRefCommit: it.targetRefCommit?.commitId ?? "",
    commonRefCommit: it.commonRefCommit?.commitId ?? "",
    createdDate: it.createdDate ?? "",
  }));
}

interface RawChangeEntry {
  changeTrackingId?: number;
  changeId?: number;
  changeType?: string;
  originalPath?: string;
  item?: {
    path?: string;
    objectId?: string;
    originalObjectId?: string;
    isFolder?: boolean;
    gitObjectType?: string;
  };
}

interface RawChanges {
  changeEntries?: RawChangeEntry[];
  nextSkip?: number;
  nextTop?: number;
}

function normalizeChangeType(raw: string | undefined): ChangeType {
  const t = (raw ?? "").toLowerCase();
  if (t.includes("delete")) return "delete";
  if (t.includes("rename")) return "rename";
  if (t.includes("add")) return "add";
  if (t.includes("edit")) return "edit";
  return "other";
}

/**
 * Files changed in `iterationId`. compareTo=0 (default) diffs against the merge base,
 * i.e. the full PR; compareTo=K yields only what changed since iteration K.
 */
export async function getIterationChanges(
  ref: PrRef,
  iterationId: number,
  compareTo = 0,
): Promise<ChangeEntry[]> {
  const out: ChangeEntry[] = [];
  const top = 2000; // API max
  let skip = 0;

  for (;;) {
    const res = await adoGet<RawChanges>(`${prBase(ref)}/iterations/${iterationId}/changes`, {
      query: { $compareTo: compareTo, $top: top, $skip: skip },
    });
    const entries = res.changeEntries ?? [];
    for (const e of entries) {
      const path = e.item?.path;
      if (!path) continue;
      if (e.item?.isFolder) continue;
      // Folders sometimes come through only as gitObjectType.
      if (e.item?.gitObjectType && e.item.gitObjectType.toLowerCase() === "tree") continue;
      out.push({
        path,
        originalPath: e.originalPath,
        changeType: normalizeChangeType(e.changeType),
        objectId: e.item?.objectId,
        originalObjectId: e.item?.originalObjectId,
        changeTrackingId: e.changeTrackingId,
        isFolder: false,
      });
    }
    if (entries.length < top || res.nextSkip === undefined) break;
    skip = res.nextSkip;
  }
  return out;
}
