package findings

type Finding struct {
	Kind          string         `json:"kind"`
	ID            string         `json:"id"`
	Rule          string         `json:"rule"`
	Severity      string         `json:"severity"`
	Category      string         `json:"category"`
	ResourceLabel string         `json:"resource_label"`
	ResourceKey   string         `json:"resource_key"`
	ResourceName  string         `json:"resource_name,omitempty"`
	AccountID     string         `json:"account_id"`
	Region        string         `json:"region"`
	SnapshotID    string         `json:"snapshot_id"`
	Message       string         `json:"message"`
	Remediation   string         `json:"remediation"`
	Evidence      map[string]any `json:"evidence,omitempty"`

	// Set when a baseline entry accepts this risk. The finding is still emitted
	// so an accepted risk stays visible and reviewable.
	Suppressed        bool   `json:"suppressed,omitempty"`
	SuppressionReason string `json:"suppression_reason,omitempty"`
	SuppressionOwner  string `json:"suppression_owner,omitempty"`
}
