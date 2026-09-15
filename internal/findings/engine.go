package findings

import "sort"

var severityRank = map[string]int{"critical": 5, "high": 4, "medium": 3, "low": 2, "info": 1}

var ruleOrder = []func(*Graph) []Finding{
	ruleS3PublicBucket,
	ruleOpenIngress,
	ruleIamWildcardAdmin,
	ruleIamTrustWildcard,
	ruleCrossEnvEdge,
	ruleUnencryptedStorage,
	ruleUnassociatedResources,
	ruleCostIdle,
	ruleFlowLogsDisabled,
	ruleOrphanSG,
	ruleMissingTags,
}

func Run(g *Graph) []Finding {
	var out []Finding
	for _, r := range ruleOrder {
		out = append(out, r(g)...)
	}
	sort.SliceStable(out, func(i, j int) bool {
		ri, rj := severityRank[out[i].Severity], severityRank[out[j].Severity]
		if ri != rj {
			return ri > rj
		}
		if out[i].Rule != out[j].Rule {
			return out[i].Rule < out[j].Rule
		}
		return out[i].ResourceKey < out[j].ResourceKey
	})
	return out
}
