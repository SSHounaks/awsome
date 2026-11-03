import React, { useState, useEffect, useMemo, useRef, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlow, ReactFlowProvider, useReactFlow, Background, Controls, MiniMap, MarkerType, Handle, Position } from "@xyflow/react";
import dagre from "dagre";
import { marked } from "marked";
import DOMPurify from "dompurify";

/* ---------- official AWS Architecture Icons ----------
 * @aws-icons/react (MIT) packages AWS's published Architecture Icon set as React
 * components. Pinned to react@18.3.1 via ?deps so esm.sh does not pull a second
 * React copy (that would break hooks). Each import is a separate module, so only
 * the icons listed here are fetched — not all 700+.
 */
import IconEc2 from "@aws-icons/react/architecture-service/amazon-ec2";
import IconS3 from "@aws-icons/react/architecture-service/amazon-simple-storage-service";
import IconRds from "@aws-icons/react/architecture-service/amazon-rds";
import IconLambda from "@aws-icons/react/architecture-service/aws-lambda";
import IconDynamo from "@aws-icons/react/architecture-service/amazon-dynamo-db";
import IconElastiCache from "@aws-icons/react/architecture-service/amazon-elasti-cache";
import IconEcs from "@aws-icons/react/architecture-service/amazon-elastic-container-service";
import IconEks from "@aws-icons/react/architecture-service/amazon-elastic-kubernetes-service";
import IconEcr from "@aws-icons/react/architecture-service/amazon-elastic-container-registry";
import IconElb from "@aws-icons/react/architecture-service/elastic-load-balancing";
import IconIam from "@aws-icons/react/architecture-service/aws-identity-and-access-management";
import IconEbs from "@aws-icons/react/architecture-service/amazon-elastic-block-store";
import IconRedshift from "@aws-icons/react/architecture-service/amazon-redshift";
import IconEni from "@aws-icons/react/resource/amazon-vpc-elastic-network-interface";
import IconFlowLogs from "@aws-icons/react/resource/amazon-vpc-flow-logs";
import IconIgw from "@aws-icons/react/resource/amazon-vpc-internet-gateway";
import IconNacl from "@aws-icons/react/resource/amazon-vpc-network-access-control-list";
import IconEip from "@aws-icons/react/resource/amazon-ec2-elastic-ip-address";
import IconAmi from "@aws-icons/react/resource/amazon-ec2-ami";
import IconPeering from "@aws-icons/react/resource/amazon-vpc-peering-connection";
import IconRouteTable from "@aws-icons/react/resource/amazon-route-53-route-table";
import IconVpc from "@aws-icons/react/architecture-group/virtual-private-cloud-vpc";
import IconPublicSubnet from "@aws-icons/react/architecture-group/public-subnet";
import IconPrivateSubnet from "@aws-icons/react/architecture-group/private-subnet";
import IconAsg from "@aws-icons/react/architecture-group/auto-scaling-group";

// Node label -> icon. Labels with no published AWS icon (e.g. security groups,
// RDS subnet groups) fall back to the initial-letter chip in AwsNode.
const AWS_ICON = {
  EC2: IconEc2,
  S3BUCKET: IconS3,
  RDS: IconRds,
  LAMBDA: IconLambda,
  DYNAMODBTABLE: IconDynamo,
  ELASTICACHE: IconElastiCache,
  ECSCLUSTER: IconEcs,
  EKS: IconEks,
  ECRREPOSITORY: IconEcr,
  LB: IconElb,
  TARGETGROUP: IconElb,
  IAMROLE: IconIam,
  IAMPOLICY: IconIam,
  IAMPROFILE: IconIam,
  VOLUME: IconEbs,
  REDSHIFT: IconRedshift,
  ENI: IconEni,
  FLOWLOG: IconFlowLogs,
  IGW: IconIgw,
  NACL: IconNacl,
  EIP: IconEip,
  AMI: IconAmi,
  VPCPEERING: IconPeering,
  ROUTETABLE: IconRouteTable,
  VPC: IconVpc,
  ASG: IconAsg,
};

// A subnet's icon depends on whether it is public, which the graph payload tells
// us via properties.map_public_ip.
function iconFor(label, properties) {
  if (label === "SUBNET") return properties?.map_public_ip ? IconPublicSubnet : IconPrivateSubnet;
  return AWS_ICON[label] ?? null;
}

// The export lifts rendered glyphs out of the DOM, so it needs a key for the
// glyph rather than for the node. Only the subnet icon varies by property.
function iconKey(label, properties) {
  if (!label) return "";
  return label === "SUBNET" ? (properties?.map_public_ip ? "SUBNET:public" : "SUBNET:private") : String(label);
}

const h = React.createElement;

const cx = (...xs) => xs.filter(Boolean).join(" ");

/* ---------- markdown rendering (assistant replies) ---------- */
const MD_OPTS = { gfm: true, breaks: true };

function renderMarkdown(text) {
  if (!text) return "";
  try {
    const out = marked.parse ? marked.parse(text, MD_OPTS) : marked(text);
    return DOMPurify.sanitize(String(out ?? ""));
  } catch {
    return String(text);
  }
}

function Md({ text, className }) {
  return h("div", {
    className: cx("md-body", className),
    dangerouslySetInnerHTML: { __html: renderMarkdown(text) },
  });
}

/* ---------- design tokens (Tailwind literal classes) ---------- */
const SEV = {
  critical: { badge: "sevbadge-critical", dot: "sevdot-critical", hex: "#f87171" },
  high:     { badge: "sevbadge-high",     dot: "sevdot-high",     hex: "#fb923c" },
  medium:   { badge: "sevbadge-medium",   dot: "sevdot-medium",   hex: "#fcd34d" },
  low:      { badge: "sevbadge-low",      dot: "sevdot-low",      hex: "#6ee7b7" },
  info:     { badge: "sevbadge-info",     dot: "sevdot-info",     hex: "#7dd3fc" },
};
const SEV_W = { critical: 15, high: 7, medium: 3, low: 1, info: 0 };
const SEV_ORDER = ["critical", "high", "medium", "low", "info"];

const JOB = {
  queued:      { dot: "bg-slate-400",              txt: "text-slate-300" },
  running:     { dot: "bg-sky-400",                txt: "text-sky-300 animate-pulse" },
  cancelling:  { dot: "bg-amber-300",              txt: "text-amber-200" },
  cancelled:   { dot: "bg-slate-500",              txt: "text-slate-400" },
  completed:   { dot: "bg-emerald-400",            txt: "text-emerald-300" },
  failed:      { dot: "bg-red-400",                txt: "text-red-300" },
  interrupted: { dot: "bg-amber-300",              txt: "text-amber-200" },
};
const RESUMEABLE = ["interrupted", "cancelled", "failed"];

function posture(findings) {
  const c = findings?.bySeverity ?? {};
  const pen = SEV_ORDER.slice(0, 4).reduce((a, s) => a + (c[s] ?? 0) * SEV_W[s], 0);
  const score = Math.max(0, 100 - Math.round(2.2 * Math.sqrt(pen)));
  const grade = score >= 93 ? "A" : score >= 80 ? "B" : score >= 63 ? "C" : score >= 45 ? "D" : "F";
  return { score, grade, pen };
}
const ringColor = (s) => (s >= 80 ? "#34d399" : s >= 63 ? "#22d3ee" : s >= 45 ? "#fb923c" : "#f87171");

/* ---------- tiny icon set ---------- */
const ICONS = {
  dashboard: { rects: [[3, 3, 7, 9], [14, 3, 7, 6], [3, 16, 7, 5], [14, 13, 7, 8]] },
  graph: { circles: [[6, 5, 2], [6, 19, 2], [18, 12, 2]], lines: [[8, 6, 16, 11], [8, 18, 16, 13]] },
  alert: { paths: ["M12 3l7 3v5c0 4.6-3 8.2-7 10-4-1.8-7-5.4-7-10V6l7-3z", "M12 8.5v3.5", "M12 15h.01"] },
  scan: { paths: ["M10 2H6a4 4 0 0 0-4 4v4", "M14 2h4a4 4 0 0 1 4 4v4", "M10 22H6a4 4 0 0 1-4-4v-4", "M14 22h4a4 4 0 0 0 4-4v-4"], lines: [[12, 9, 12, 11], [12, 13, 12, 15], [9, 12, 11, 12], [13, 12, 15, 12]] },
  message: { paths: ["M4 5h16v12H8l-4 4V5z"] },
  drift: { paths: ["M17 13l3 3-3 3", "M7 11L4 8l3-3"], lines: [[20, 16, 8, 16], [4, 8, 16, 8]] },
  search: { paths: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M21 21l-4.3-4.3"] },
  download: { paths: ["M21 15v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3", "M7 10l5 5 5-5", "M12 15V3"] },
  refresh: { paths: ["M21 4v5h-5", "M20.5 9A9 9 0 1 0 22 14", "M3 20v-5h5", "M3.5 15A9 9 0 1 0 2 10"] },
  swap: { paths: ["M7 7h13", "M7 3l4 4-4 4", "M17 17H4", "M17 13l4 4-4 4"] },
  key: { paths: ["M5 11h14v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-8z", "M7 11V7a5 5 0 0 1 10 0v4"] },
  chevron: { paths: ["M6 9l6 6 6-6"] },
  arrowRight: { paths: ["M5 12h14", "M13 6l6 6-6 6"] },
  x: { paths: ["M18 6L6 18", "M6 6l12 12"] },
  external: { paths: ["M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5", "M15 3h6v6", "M10 14L21 3"] },
  play: { paths: ["M7 4l12 8-12 8z"], fill: true },
  stop: { rects: [[6, 4, 12, 14]], fill: true },
  box: { paths: ["M21 8l-9-5-9 5v8l9 5 9-5V8z", "M3 8l9 5 9-5", "M12 13v8"] },
  zap: { paths: ["M13 2L3 14h7l-1 8 11-12h-7l1-8z"], fill: true },
  info: { circles: [[12, 12, 9]], paths: ["M12 11v5", "M12 8h.01"] },
};

function Icon({ name, className }) {
  const def = ICONS[name];
  if (!def) return null;
  return h("svg", {
    className: cx("h-4 w-4", className),
    viewBox: "0 0 24 24",
    fill: def.fill ? "currentColor" : "none",
    stroke: def.fill ? "none" : "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
    (def.paths ?? []).map((d, i) => h("path", { key: "p" + i, d })),
    (def.circles ?? []).map((c, i) => h("circle", { key: "c" + i, cx: c[0], cy: c[1], r: c[2] })),
    (def.lines ?? []).map((l, i) => h("line", { key: "l" + i, x1: l[0], y1: l[1], x2: l[2], y2: l[3] })),
    (def.rects ?? []).map((r, i) => h("rect", { key: "r" + i, x: r[0], y: r[1], width: r[2], height: r[3], rx: 1.5 })),
  );
}

/* ---------- misc helpers ---------- */
function timeAgo(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const d = Date.now() - t;
  if (d < 60e3) return "just now";
  const m = Math.round(d / 60e3);
  if (m < 60) return m + "m ago";
  const hh = Math.round(m / 60);
  if (hh < 24) return hh + "h ago";
  return Math.round(hh / 24) + "d ago";
}
function fmtDT(iso) {
  if (!iso) return "—";
  const t = new Date(iso);
  if (isNaN(t)) return iso;
  return t.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function shortKey(k) { return (k ?? "").split("/").pop(); }
function pstr(v) {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/* ============================================================ */
/*  GRAPH                                                         */
/* ============================================================ */
const COLORS = {
  VPC: "#6366f1", Subnet: "#f59e0b", EC2: "#ef4444", SG: "#14b8a6", S3BUCKET: "#3b82f6",
  IAMROLE: "#eab308", ENI: "#84cc16", IGW: "#6b7280", EIP: "#1e3a5f", ROUTETABLE: "#6b7280",
  NACL: "#6b7280", RDS: "#b91c1c", REDSHIFT: "#881337", ELASTICACHE: "#9d174d",
  LB: "#ec4899", TARGETGROUP: "#db2777", ASG: "#8b5cf6", DYNAMODBTABLE: "#2563eb",
  IAMPROFILE: "#a16207", IAMPOLICY: "#ca8a04", AMI: "#64748b", OPENSEARCH: "#0ea5e9",
  ECSCLUSTER: "#059669", EKS: "#0284c7", ECRREPOSITORY: "#4f46e5", FLOWLOG: "#71717a",
  EVENTBRIDGERULE: "#c026d3",
};
const FIND_COLORS = { critical: "#ef4444", high: "#f97316", medium: "#eab308", low: "#64748b" };

/* ---------- custom React Flow node with an AWS icon ----------
 * React Flow's built-in "default" node only renders a text label, so an icon
 * needs a custom node type. Custom nodes must declare their own Handles or
 * edges have nowhere to attach.
 */
const AwsNode = React.memo(function AwsNode({ data }) {
  const Icon = data.icon;
  // Fills the box the layout allocated. Sizing to content instead made every
  // node a different width, so a fixed-grid layout could never line up: wide
  // ones overlapped their neighbour and pushed through the container border.
  return h("div", {
    className: "flex h-full w-full items-center gap-2.5 overflow-hidden rounded-lg border px-3 shadow-lg",
    style: {
      background: "#0d1320",
      borderColor: data.accentColor ?? "#475569",
      borderWidth: data.emphasised ? 2 : 1,
    },
    title: data.title,
  },
    h(Handle, { type: "target", position: Position.Left, style: { opacity: 0, width: 1, height: 1 } }),
    Icon
      ? h(Icon, { width: 30, height: 30, style: { flexShrink: 0 } })
      : h("div", {
          className: "flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded font-mono text-[13px] font-bold",
          style: { background: data.accentColor ?? "#334155", color: "#0b1220" },
          // resourceLabel, not label: the second line can be overridden to say
          // something more useful than the type, and a two-letter badge reading
          // "CR" off "cron(0 3 * * ? *)" helps nobody.
        }, (data.resourceLabel ?? data.label ?? "?").slice(0, 2)),
    h("div", { className: "min-w-0 flex-1 leading-tight" },
      h("div", { className: "truncate font-mono text-[11.5px] font-medium text-slate-100" },
        (data.marker ?? "") + (data.name ?? "")),
      h("div", { className: "truncate font-mono text-[9.5px] uppercase tracking-wide text-slate-500" }, data.label),
    ),
    h(Handle, { type: "source", position: Position.Right, style: { opacity: 0, width: 1, height: 1 } }),
  );
});

/* ---------- architecture view: nested container nodes ----------
 * React Flow renders containment through parentId + relative child positions,
 * which is what an AWS architecture diagram is: a VPC rectangle holding subnet
 * rectangles holding resources.
 */
function GroupBox({ data }) {
  return h("div", {
    className: "h-full w-full rounded-xl",
    style: {
      background: data.fill,
      border: `${data.borderWidth ?? 1.5}px ${data.borderStyle ?? "solid"} ${data.stroke}`,
      boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.02)",
    },
  },
    // Handles so an edge pointing at a container (e.g. FLOWS_ON -> VPC) still
    // has somewhere to attach.
    h(Handle, { type: "target", position: Position.Left, style: { opacity: 0, width: 1, height: 1 } }),
    h("div", { className: "flex items-center gap-2 px-3 pt-2" },
      data.icon ? h(data.icon, { width: 18, height: 18, style: { flexShrink: 0 } }) : null,
      h("div", { className: "min-w-0" },
        // Title stays near-white for legibility; the boundary colour carries the
        // public/private distinction via the border and a small leading dot.
        h("div", { className: "flex items-center gap-1.5" },
          h("span", { className: "h-1.5 w-1.5 shrink-0 rounded-full", style: { background: data.stroke } }),
          h("div", { className: "truncate font-mono text-[11.5px] font-semibold text-slate-100" }, data.title),
        ),
        data.subtitle
          ? h("div", { className: "truncate pl-3 font-mono text-[10px] text-slate-400" }, data.subtitle)
          : null,
      ),
    ),
    h(Handle, { type: "source", position: Position.Right, style: { opacity: 0, width: 1, height: 1 } }),
  );
}

const NODE_TYPES = { aws: AwsNode, group: GroupBox };

/* layout geometry */
const A_NODE_W = 208, A_NODE_H = 54, A_GAP = 14;
const A_SUB_PADX = 20, A_SUB_HEAD = 58, A_SUB_PADB = 20, A_SUB_COLS = 2;
const A_AZ_PADX = 18, A_AZ_HEAD = 44, A_AZ_PADB = 18;
const A_VPC_PADX = 24, A_VPC_HEAD = 60, A_VPC_PADB = 24;
const A_LANE_PADX = 20, A_LANE_HEAD = 46, A_LANE_PADB = 20, A_LANE_COLS = 8;

// An architecture diagram shows workloads and boundaries. Security groups,
// route tables, NACLs, target groups, EIPs and volumes are configuration
// attached to those workloads — drawing a box per item buried the subnets under
// 45 rows of them. They remain in the flow view, where relationships are the point.
const ARCH_EXCLUDE = new Set([
  "IAMROLE", "IAMPOLICY", "IAMPROFILE", "IAMUSER", "ACCOUNT", "ENI", "AMI",
  "SG", "NACL", "ROUTETABLE", "TARGETGROUP", "EIP", "VOLUME", "DBSG", "FLOWLOG",
]);
// Regional/global services live outside the VPC boundary.
const ARCH_GLOBAL = new Set(["S3BUCKET", "DYNAMODBTABLE", "ECRREPOSITORY"]);

function gridSize(n, cols, w, h, gap) {
  const c = Math.max(1, Math.min(cols, n));
  const r = Math.max(1, Math.ceil(n / c));
  return { cols: c, rows: r, w: c * w + (c - 1) * gap, h: r * h + (r - 1) * gap };
}

// layoutArchitecture turns the flat graph into nested VPC > subnet > resource
// boxes. Containment comes from vpc_id/subnet_id properties, falling back to
// IN_VPC / IN_SUBNET edges for resources that only express it as an edge
// (Lambda, for instance, carries no subnet_id property).
function layoutArchitecture(graph, opts) {
  const { overlayByKey, region } = opts;
  // Containment is resolved over every node, then filtered for drawing. An
  // Elastic IP reaches its subnet through an ENI, and ENIs are not drawn — so
  // excluding them before resolution would strand the EIP outside the VPC.
  const allNodes = graph.nodes;
  const nodes = allNodes.filter((n) => !ARCH_EXCLUDE.has(n.label));
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const prop = (n, k) => (n.properties ?? {})[k];

  const vpcs = nodes.filter((n) => n.label === "VPC");
  const subnets = nodes.filter((n) => n.label === "SUBNET");

  // Resolve short ids (vpc-abc, subnet-abc) to the ARN keys used as node ids.
  const vpcKeyByShort = new Map(vpcs.map((v) => [v.id.split("/").pop(), v.id]));
  const subKeyByShort = new Map(subnets.map((s) => [s.id.split("/").pop(), s.id]));

  const subnetOf = new Map(), vpcOf = new Map();
  for (const n of allNodes) {
    const s = prop(n, "subnet_id"), v = prop(n, "vpc_id");
    if (s && subKeyByShort.has(s)) subnetOf.set(n.id, subKeyByShort.get(s));
    if (v && vpcKeyByShort.has(v)) vpcOf.set(n.id, vpcKeyByShort.get(v));
  }
  for (const e of graph.edges) {
    if (!byId.has(e.from)) continue;
    if (e.type === "IN_SUBNET" && byId.has(e.to) && !subnetOf.has(e.from)) subnetOf.set(e.from, e.to);
    if ((e.type === "IN_VPC" || e.type === "PART_OF") && byId.has(e.to) && !vpcOf.has(e.from)) vpcOf.set(e.from, e.to);
  }
  // An auto-scaling group names its subnets rather than its VPC.
  for (const n of allNodes) {
    if (vpcOf.has(n.id)) continue;
    const zones = prop(n, "vpc_zone_identifiers");
    const first = (Array.isArray(zones) ? zones : String(zones ?? "").split(","))
      .map((s) => s.trim()).filter(Boolean)[0];
    if (first && subKeyByShort.has(first)) subnetOf.set(n.id, subKeyByShort.get(first));
  }

  // Several resources express containment only through an attachment: an
  // internet gateway is ATTACHED_TO its VPC, a flow log FLOWS_ON one, a volume
  // is ATTACHED_TO an instance, an ElastiCache node ASSOC_WITH a security group.
  // Inherit placement across those rather than special-casing each label —
  // otherwise the internet gateway floats outside the VPC it belongs to.
  const ATTACH = new Set(["ATTACHED_TO", "ASSOC_WITH", "FLOWS_ON", "PART_OF", "CONTAINS", "USES_SUBGRP"]);
  const outgoing = new Map();
  for (const e of graph.edges) {
    if (!ATTACH.has(e.type)) continue;
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    outgoing.get(e.from).push(e);
  }
  // Two passes so volume -> instance -> subnet -> vpc resolves.
  for (let pass = 0; pass < 3; pass++) {
    for (const n of allNodes) {
      if (subnetOf.has(n.id) && vpcOf.has(n.id)) continue;
      for (const e of outgoing.get(n.id) ?? []) {
        // Only a direct attachment implies sharing the target's subnet; being
        // associated with a security group says nothing about placement.
        if (!subnetOf.has(n.id) && e.type === "ATTACHED_TO" && subnetOf.has(e.to)) {
          subnetOf.set(n.id, subnetOf.get(e.to));
        }
        if (!vpcOf.has(n.id)) {
          if (byId.get(e.to)?.label === "VPC") vpcOf.set(n.id, e.to);
          else if (vpcOf.has(e.to)) vpcOf.set(n.id, vpcOf.get(e.to));
        }
      }
    }
  }

  // A resource in a subnet is in that subnet's VPC.
  for (const [id, sub] of subnetOf) {
    if (!vpcOf.has(id)) {
      const parentVpc = vpcOf.get(sub) ?? (byId.get(sub) && vpcKeyByShort.get(prop(byId.get(sub), "vpc_id")));
      if (parentVpc) vpcOf.set(id, parentVpc);
    }
  }

  const isContainer = (n) => n.label === "VPC" || n.label === "SUBNET";
  const members = nodes.filter((n) => !isContainer(n));

  const inSubnet = new Map(subnets.map((s) => [s.id, []]));
  const inVpcOnly = new Map(vpcs.map((v) => [v.id, []]));
  const global = [];
  for (const m of members) {
    const s = subnetOf.get(m.id), v = vpcOf.get(m.id);
    if (s && inSubnet.has(s) && !ARCH_GLOBAL.has(m.label)) inSubnet.get(s).push(m);
    else if (v && inVpcOnly.has(v) && !ARCH_GLOBAL.has(m.label)) inVpcOnly.get(v).push(m);
    else global.push(m);
  }

  const out = [];
  const leaf = (n, parentId, x, y) => {
    const ov = overlayByKey?.get(n.id);
    out.push({
      id: n.id, type: "aws", parentId, extent: parentId ? "parent" : undefined,
      position: { x, y },
      // Explicit size: the layout reserves exactly this much room, so the node
      // must occupy exactly this much and no more.
      style: { width: A_NODE_W, height: A_NODE_H },
      width: A_NODE_W, height: A_NODE_H,
      data: {
        // RDS/ElastiCache ARNs are colon-separated, so a "/" split returns the
        // whole ARN. Fall back through both separators.
        name: n.name || n.id.split("/").pop().split(":").pop(), label: n.label,
        marker: ov === "add" ? "+ " : ov === "mod" ? "~ " : "",
        resourceLabel: n.label, icon: iconFor(n.label, n.properties), iconKey: iconKey(n.label, n.properties),
        accentColor: ov === "add" ? "#4ade80" : ov === "mod" ? "#fbbf24" : (COLORS[n.label] ?? "#475569"),
        emphasised: Boolean(ov),
        title: `${n.name || ""}\n${n.label}\n${n.id}`,
      },
    });
  };

  // --- size each subnet from its contents, then pack subnets into their VPC ---
  const subSize = new Map();
  for (const s of subnets) {
    const n = inSubnet.get(s.id).length;
    // Grow a dense subnet sideways rather than into a 7-row tower, otherwise one
    // busy AZ stretches its column far past the others and the VPC fills with
    // empty space.
    const cols = Math.max(A_SUB_COLS, Math.min(4, Math.ceil(Math.sqrt(n))));
    const g = gridSize(n, cols, A_NODE_W, A_NODE_H, A_GAP);
    subSize.set(s.id, { w: g.w + 2 * A_SUB_PADX, h: A_SUB_HEAD + g.h + A_SUB_PADB, g });
  }

  let cursorY = 0;
  for (const v of vpcs) {
    const mine = subnets.filter((s) => (vpcOf.get(s.id) ?? vpcKeyByShort.get(prop(s, "vpc_id"))) === v.id);

    // Availability zones become columns — the structure every AWS architecture
    // diagram uses, and it lays the VPC out wide instead of one tall stack.
    const azNames = [...new Set(mine.map((s) => prop(s, "az") || "no-az"))].sort();
    const azCols = azNames.map((az) => {
      // public subnets on top, matching how traffic flows in
      const subs = mine.filter((s) => (prop(s, "az") || "no-az") === az)
        .sort((a, b) => Number(Boolean(prop(b, "map_public_ip"))) - Number(Boolean(prop(a, "map_public_ip"))));
      const w = Math.max(...subs.map((s) => subSize.get(s.id).w), A_NODE_W);
      const h = subs.reduce((acc, s) => acc + subSize.get(s.id).h, 0) + Math.max(0, subs.length - 1) * A_GAP;
      return { az, subs, w: w + 2 * A_AZ_PADX, h: A_AZ_HEAD + h + A_AZ_PADB };
    });

    let innerW = azCols.reduce((acc, c) => acc + c.w, 0) + Math.max(0, azCols.length - 1) * A_GAP;
    let innerH = Math.max(0, ...azCols.map((c) => c.h));

    // Anything VPC-scoped but not in a subnet (load balancers, gateways).
    const loose = inVpcOnly.get(v.id) ?? [];
    let looseTop = 0;
    if (loose.length) {
      looseTop = innerH ? innerH + A_GAP : 0;
      const cols = Math.max(2, Math.min(loose.length, Math.floor(Math.max(innerW, A_NODE_W * 3) / (A_NODE_W + A_GAP))));
      const g = gridSize(loose.length, cols, A_NODE_W, A_NODE_H, A_GAP);
      innerW = Math.max(innerW, g.w);
      innerH = looseTop + g.h;
      loose.cols = g.cols;
    }

    const box = {
      w: Math.max(innerW, 340) + 2 * A_VPC_PADX,
      h: A_VPC_HEAD + Math.max(innerH, A_NODE_H) + A_VPC_PADB,
      x: 0, y: cursorY,
    };
    cursorY += box.h + 26;

    out.push({
      id: v.id, type: "group", position: { x: box.x, y: box.y },
      style: { width: box.w, height: box.h },
      selectable: false, draggable: false, zIndex: 0,
      data: {
        title: `VPC  ${v.name || v.id.split("/").pop()}`,
        subtitle: [prop(v, "cidr_block"), prop(v, "default_vpc") ? "default VPC" : null].filter(Boolean).join("   ·   "),
        fill: "rgba(99,102,241,0.05)", stroke: "#6366f1", icon: IconVpc,
      },
    });

    let azX = 0;
    for (const col of azCols) {
      const azId = `${v.id}__az__${col.az}`;
      out.push({
        id: azId, type: "group", parentId: v.id, extent: "parent",
        position: { x: A_VPC_PADX + azX, y: A_VPC_HEAD },
        style: { width: col.w, height: col.h },
        selectable: false, draggable: false, zIndex: 1,
        data: {
          title: col.az, fill: "rgba(148,163,184,0.03)", stroke: "#475569",
          borderStyle: "dashed", borderWidth: 1,
        },
      });

      let subY = A_AZ_HEAD;
      for (const s of col.subs) {
        const sz = subSize.get(s.id);
        const isPublic = Boolean(prop(s, "map_public_ip"));
        out.push({
          id: s.id, type: "group", parentId: azId, extent: "parent",
          position: { x: A_AZ_PADX, y: subY },
          style: { width: sz.w, height: sz.h },
          selectable: false, draggable: false, zIndex: 2,
          data: {
            title: s.name || s.id.split("/").pop(),
            subtitle: [isPublic ? "public" : "private", prop(s, "cidr_block")].filter(Boolean).join("   ·   "),
            fill: isPublic ? "rgba(34,197,94,0.07)" : "rgba(56,189,248,0.06)",
            stroke: isPublic ? "#22c55e" : "#38bdf8",
            borderStyle: isPublic ? "solid" : "dashed",
            icon: isPublic ? IconPublicSubnet : IconPrivateSubnet,
          },
        });
        inSubnet.get(s.id).forEach((m, i) => {
          const c = i % sz.g.cols, r = Math.floor(i / sz.g.cols);
          leaf(m, s.id, A_SUB_PADX + c * (A_NODE_W + A_GAP), A_SUB_HEAD + r * (A_NODE_H + A_GAP));
        });
        subY += sz.h + A_GAP;
      }
      azX += col.w + A_GAP;
    }

    const looseCols = loose.cols || 2;
    loose.forEach((m, i) => {
      const c = i % looseCols, r = Math.floor(i / looseCols);
      leaf(m, v.id, A_VPC_PADX + c * (A_NODE_W + A_GAP), A_VPC_HEAD + looseTop + r * (A_NODE_H + A_GAP));
    });
  }

  // --- regional / global services, grouped by service so like sits with like ---
  if (global.length) {
    const byLabel = new Map();
    for (const m of global) {
      if (!byLabel.has(m.label)) byLabel.set(m.label, []);
      byLabel.get(m.label).push(m);
    }
    // Biggest groups first, so the lane reads densest-to-sparsest.
    const buckets = [...byLabel.entries()]
      .map(([label, items]) => {
        const g = gridSize(items.length, A_LANE_COLS, A_NODE_W, A_NODE_H, A_GAP);
        return { label, items, g, w: g.w + 2 * A_SUB_PADX, h: A_SUB_HEAD + g.h + A_SUB_PADB };
      })
      .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));

    // Pack the service groups into rows. Stacking them vertically made the lane
    // so tall that fitView zoomed out past readability, with four single-row
    // groups each claiming a full row of their own.
    const LANE_MAXW = 1560;
    let lx = 0, ly = 0, rowH = 0, innerW = 0;
    for (const b of buckets) {
      if (lx > 0 && lx + b.w > LANE_MAXW) { lx = 0; ly += rowH + A_GAP; rowH = 0; }
      b.x = lx; b.y = ly;
      lx += b.w + A_GAP;
      rowH = Math.max(rowH, b.h);
      innerW = Math.max(innerW, lx - A_GAP);
    }
    const innerH = ly + rowH;
    const box = { w: innerW + 2 * A_LANE_PADX, h: A_LANE_HEAD + innerH + A_LANE_PADB, x: 0, y: cursorY };

    out.push({
      id: "__region_lane__", type: "group", position: { x: box.x, y: box.y },
      style: { width: box.w, height: box.h },
      selectable: false, draggable: false, zIndex: 0,
      data: {
        title: "Regional & global services",
        subtitle: region ? `${region}   ·   outside the VPC boundary` : "outside the VPC boundary",
        fill: "rgba(148,163,184,0.04)", stroke: "#64748b", borderStyle: "dashed",
      },
    });

    for (const b of buckets) {
      const gid = `__lane__${b.label}`;
      out.push({
        id: gid, type: "group", parentId: "__region_lane__", extent: "parent",
        position: { x: A_LANE_PADX + b.x, y: A_LANE_HEAD + b.y },
        style: { width: b.w, height: b.h },
        selectable: false, draggable: false, zIndex: 1,
        data: {
          title: LANE_TITLES[b.label] ?? b.label,
          subtitle: `${b.items.length}`,
          fill: "rgba(148,163,184,0.04)", stroke: COLORS[b.label] ?? "#64748b",
          borderStyle: "solid", borderWidth: 1,
          icon: iconFor(b.label, null), iconKey: iconKey(b.label, null),
        },
      });
      b.items.forEach((m, i) => {
        const c = i % b.g.cols, r = Math.floor(i / b.g.cols);
        leaf(m, gid, A_SUB_PADX + c * (A_NODE_W + A_GAP), A_SUB_HEAD + r * (A_NODE_H + A_GAP));
      });
    }
  }

  return out;
}

const LANE_TITLES = {
  EVENTBRIDGERULE: "EventBridge rules",
  S3BUCKET: "S3 buckets",
  ECRREPOSITORY: "ECR repositories",
  DYNAMODBTABLE: "DynamoDB tables",
  LAMBDA: "Lambda functions (no VPC)",
  ECSCLUSTER: "ECS clusters",
  EKS: "EKS clusters",
  ASG: "Auto Scaling groups",
  IGW: "Internet gateways (detached)",
  VOLUME: "EBS volumes (unattached)",
  RDS: "RDS instances",
  ELASTICACHE: "ElastiCache clusters",
};

/* ---------- architecture view: request path by tier ----------
 * The component view answers "what runs where". This one answers "what talks to
 * what": resources are placed in the tier their role puts them in, laid out
 * left-to-right in the direction traffic flows, with one lane per account so
 * cross-account trust is visible as a line between lanes.
 */
const TIERS = [
  // Upstream of the edge because a schedule is where a request comes from, the
  // same way the internet is — it just arrives on a clock instead of a socket.
  { id: "schedule", title: "Triggers", hint: "scheduled and event-driven", labels: ["EVENTBRIDGERULE"] },
  { id: "edge", title: "Edge", hint: "internet-facing", labels: ["IGW", "LB"] },
  { id: "compute", title: "Compute", hint: "application tier", labels: ["EC2", "LAMBDA", "ECSCLUSTER", "EKS", "ASG"] },
  { id: "data", title: "Data", hint: "state and artefacts", labels: ["RDS", "ELASTICACHE", "DYNAMODBTABLE", "REDSHIFT", "OPENSEARCH", "S3BUCKET", "ECRREPOSITORY"] },
  { id: "identity", title: "Identity", hint: "assumable roles", labels: ["__trusted_role__"] },
];

const A_LANE_HEAD2 = 52, A_TIER_HEAD = 40, A_TIER_PADX = 16, A_TIER_PADB = 16;

// ---- architecture edge derivation -------------------------------------------
// Five different claims, kept distinct because they mean different things:
//   USES    — an IAM policy names this resource, so the caller genuinely uses it
//   FORWARDS— a load balancer sends requests here
//   ADMITS  — a security group lets an address outside the VPC open a connection
//   TUNNELS — reachable from outside with no inbound rule at all
//   REACHES — a security group admits the traffic, so it *could* talk to it
const INTERNET_ID = "__internet__";
const CIDR_PREFIX = "__cidr__";

// Ports whose exposure changes what an edge means, mirroring the scanner's
// sensitivePorts and databasePorts so the diagram and the findings cannot
// disagree about which paths are the dangerous ones.
const ADMIN_PORTS = new Set([22, 23, 135, 445, 3389, 5985, 5986]);
const DATA_PORTS = new Set([1433, 1521, 3306, 5432, 5984, 6379, 7000, 9042, 9200, 11211, 27017]);
const FRONT_DOOR_PORTS = new Set([80, 443]);

function ipToInt(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return null;
  let v = 0;
  for (const o of parts) {
    const n = Number(o);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    v = v * 256 + n;
  }
  return v;
}

// cidrRange returns the inclusive address range a CIDR covers, or null for
// anything that is not parseable IPv4 — IPv6 rules are classified by their
// prefix rather than matched against addresses.
function cidrRange(c) {
  const [base, bitsRaw] = String(c).split("/");
  const b = ipToInt(base);
  if (b === null) return null;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = 2 ** (32 - bits);
  const start = Math.floor(b / size) * size;
  return [start, start + size - 1];
}

const isWorldCIDR = (c) => c === "0.0.0.0/0" || c === "::/0";
const isPrivateCIDR = (c) =>
  /^10\./.test(c) || /^192\.168\./.test(c) || /^172\.(1[6-9]|2\d|3[01])\./.test(c);

// Neo4j cannot store a nested map, so security-group rules arrive as an array
// of JSON strings. Parsing in one place keeps every caller from having to know
// that — and iterating the raw array gets you characters, silently.
function parseRules(node, key) {
  const raw = node?.properties?.[key];
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (r && typeof r === "object") { out.push(r); continue; }
    if (typeof r !== "string") continue;
    try { out.push(JSON.parse(r)); } catch { /* a rule we cannot read is not a rule we can draw */ }
  }
  return out;
}

// ruleSpan reads a rule's port range. `null` ports mean every port, which is
// how an all-protocol rule is recorded.
function ruleSpan(r) {
  const from = r?.from, to = r?.to;
  if (from === null || from === undefined || r?.protocol === "-1") return { all: true, from: 0, to: 65535 };
  const f = Number(from), t = Number(to === null || to === undefined ? from : to);
  if (!Number.isFinite(f) || !Number.isFinite(t)) return { all: true, from: 0, to: 65535 };
  return { all: f === 0 && t === 65535, from: f, to: t };
}

const spanLabel = (s) => (s.all ? "all" : s.from === s.to ? String(s.from) : `${s.from}-${s.to}`);
const spanHits = (s, set) => {
  if (s.all) return true;
  for (const p of set) if (p >= s.from && p <= s.to) return true;
  return false;
};

// One table, so the canvas, the SVG export and the legend cannot drift apart.
// Form carries the claim; colour carries the claim until risk overrides it.
const CLAIM_STYLE = {
  TUNNELS: { stroke: "#f87171", width: 1.8, dash: "2 3", z: 8,
    desc: "reached from outside with no inbound rule at all — an outbound-established path" },
  // Pink, not amber: amber means medium risk here, and a colour that means two
  // things means neither.
  ADMITS: { stroke: "#f472b6", width: 1.6, dash: "", z: 7,
    desc: "a security group lets an address outside the VPC open a connection" },
  USES: { stroke: "#34d399", width: 1.8, dash: "", z: 6,
    desc: "an IAM policy names this resource — a dependency that is real, not merely possible" },
  FORWARDS: { stroke: "#38bdf8", width: 1.8, dash: "", z: 6,
    desc: "a load balancer sends requests here" },
  TRUSTS: { stroke: "#a78bfa", width: 1.4, dash: "5 4", z: 6,
    desc: "a role trust policy accepts this principal" },
  // FIRES, not TRIGGERS: the collected edge is called TRIGGERS and is hidden in
  // favour of this one, so the two must not share a name or hiding the raw edge
  // would hide the claim that replaces it.
  FIRES: { stroke: "#c026d3", width: 1.8, dash: "", z: 6,
    desc: "an enabled EventBridge rule fires this on a schedule or an event" },
  // A disabled rule is still wired to its target. Drawing that like a live one
  // would state the opposite of the only fact worth knowing about it, so it
  // gets the faint-dashes treatment reachability gets: wired, but nothing flows.
  DORMANT: { stroke: "#c026d3", width: 1.4, dash: "3 4", z: 4, opacity: 0.5,
    desc: "the rule names this target but is DISABLED — nothing fires" },
  REACHES: { stroke: "#475569", width: 1, dash: "3 4", z: 3, opacity: 0.55,
    desc: "a security group would admit the traffic; nothing proves anything flows" },
  // data-flow claims
  ADMINS: { stroke: "#f87171", width: 1.8, dash: "", z: 8,
    desc: "a wildcard action on this store — read, write and delete, including the audit trail" },
  WRITES: { stroke: "#fb923c", width: 1.8, dash: "", z: 7,
    desc: "can change what is stored here, not only read it" },
  READS: { stroke: "#38bdf8", width: 1.4, dash: "", z: 5,
    desc: "can read what is stored here" },
  // network topology
  ROUTES: { stroke: "#fbbf24", width: 1.6, dash: "", z: 6,
    desc: "a route table on this subnet sends the default route to an internet gateway" },
};
// styleClaim turns a derived edge into a React Flow one. Solid for a real
// dependency, faint dashes for mere reachability: the two make different claims
// and should not look alike. Severity overrides the claim colour, because a line
// that represents a way in should read as one before it reads as a category.
function styleClaim(e) {
  const c = CLAIM_STYLE[e.type] ?? { stroke: "#475569", width: 1.2, dash: "", z: 6 };
  const risky = Boolean(RISK_STROKE[e.risk]);
  const stroke = risky ? RISK_STROKE[e.risk] : c.stroke;
  return {
    id: `${e.from}→${e.to}→${e.type}`, source: e.from, target: e.to, type: "default",
    // React Flow's `type` is the renderer; keep the claim it represents, and how
    // bad it is, so the SVG and HTML exports can match.
    kind: e.type, risk: e.risk ?? null,
    animated: e.type === "REFERENCES" || e.type === "TUNNELS",
    markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 13, height: 13 },
    style: {
      stroke,
      strokeWidth: risky ? c.width + 0.4 : c.width,
      ...(c.dash ? { strokeDasharray: c.dash } : {}),
      ...(c.opacity && !risky ? { opacity: c.opacity } : {}),
    },
    label: e.ports ? `:${e.ports}` : (e.count > 1 ? `×${e.count}` : undefined),
    labelStyle: { fontSize: 9, fill: risky ? stroke : "#94a3b8" },
    labelBgStyle: { fill: "#070b14", fillOpacity: 0.85 },
    zIndex: risky ? 9 : c.z,
  };
}

const ARCH_CLAIMS = Object.keys(CLAIM_STYLE);
// Views whose edges are derived rather than collected. They share styling, the
// legend, focus mode and the exports; only what they mean differs.
const DERIVED_VIEWS = new Set(["arch", "dataflow", "attack", "network", "accounts"]);
const DIAGRAM_VIEWS = ["component", "arch", "flow", "dataflow", "attack", "network", "accounts"];
const VIEW_LABEL = {
  component: "component", arch: "architecture", flow: "flow",
  dataflow: "data", attack: "attack", network: "network", accounts: "accounts",
};
const VIEW_HINT = {
  component: "Component view — VPC and subnet boundaries with resources nested inside (what runs where)",
  arch: "Architecture view — request path by tier, one lane per account (what talks to what)",
  flow: "Flow view — raw dependency graph, laid out left to right",
  dataflow: "Data flow — which workloads can read, change or administer which stores, from the IAM actions they are granted",
  attack: "Attack paths — routes from the internet to something worth reaching, worst first",
  network: "Network topology — subnets by availability zone, public or private by whether a route reaches an internet gateway",
  accounts: "Cross-account map — only what crosses an account boundary, and through what",
};
const RISK_STROKE = { high: "#f87171", medium: "#fbbf24" };
const RISK_DESC = {
  high: "open to the internet, or a database port reachable from outside the VPC",
  medium: "an allowlisted external address, or an all-ports rule across an internal range",
};

// resourceARNsIn pulls the resource ARNs a policy document grants on. Wildcards
// name no specific resource, so they are skipped rather than linked to
// everything.
function resourceARNsIn(doc) {
  const out = [];
  let parsed;
  try { parsed = JSON.parse(doc); } catch { return out; }
  const stmts = Array.isArray(parsed?.Statement) ? parsed.Statement : [];
  for (const st of stmts) {
    if (String(st?.Effect ?? "").toLowerCase() !== "allow") continue;
    const res = Array.isArray(st.Resource) ? st.Resource : st.Resource ? [st.Resource] : [];
    for (const r of res) {
      if (typeof r !== "string" || r === "*" || !r.startsWith("arn:")) continue;
      out.push(r);
    }
  }
  return out;
}

// arnRoot strips a trailing wildcard or sub-path so "arn:...:bucket/*" matches
// the bucket node "arn:...:bucket".
function arnRoot(arn) {
  let a = arn.replace(/\/\*$/, "").replace(/\*$/, "");
  return a.replace(/\/$/, "");
}

// Workload grouping infers which application a resource belongs to from its
// name. Names usually encode it — "<org>-<env>-media-processor",
// "support-triage-<env>-config" — so removing the tokens shared across the
// estate leaves the application.
//
// The org prefix is derived, not hardcoded: any token appearing in most names is
// boilerplate for that account, whatever the organisation calls itself.
// Environment markers are recognised by shape rather than by name.
const ENV_TOKEN = /^(alpha|prd|prod|dev|test|stg|staging|qa|uat|sandbox)\d*$/i;

function makeAppOf(names) {
  const freq = new Map();
  let total = 0;
  for (const nm of names) {
    if (!nm) continue;
    total++;
    for (const t of new Set(String(nm).split(/[-_/.]/).filter(Boolean))) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  // A token in over half the names identifies the estate, not the workload.
  const boilerplate = new Set();
  for (const [t, c] of freq) {
    if (total >= 4 && c / total > 0.5) boilerplate.add(t);
  }
  return (name) => {
    if (!name) return "other";
    const kept = String(name).split(/[-_/.]/).filter(Boolean)
      .filter((t) => !ENV_TOKEN.test(t) && !boilerplate.has(t));
    return kept.length ? kept.slice(0, 2).join("-").toLowerCase() : "other";
  };
}

function deriveArchEdges(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const label = (id) => byId.get(id)?.label;

  // --- collapse ENIs into their owner --------------------------------------
  const owner = new Map();
  for (const e of graph.edges) {
    if (e.type === "ATTACHES" && label(e.to) === "ENI") owner.set(e.to, e.from);
    if (e.type === "ATTACHED_TO" && label(e.from) === "ENI") owner.set(e.from, e.to);
  }
  const resolve = (id) => {
    let cur = id;
    for (let i = 0; i < 3 && label(cur) === "ENI"; i++) {
      const nxt = owner.get(cur);
      if (!nxt) break;
      cur = nxt;
    }
    return cur;
  };

  const edges = [];
  const seen = new Set();
  const push = (from, to, type, extra) => {
    if (!from || !to || from === to) return;
    const k = `${from}->${to}->${type}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ from, to, type, ...extra });
  };

  // --- 1. IAM-policy dependencies: what a workload actually uses -----------
  const rolesOf = new Map();     // compute -> [roleArn]
  const profileRole = new Map(); // instance profile -> role
  for (const e of graph.edges) {
    if (e.type === "HAS_ROLE") profileRole.set(e.from, e.to);
  }
  for (const e of graph.edges) {
    if (e.type === "USES_ROLE") {
      if (!rolesOf.has(e.from)) rolesOf.set(e.from, []);
      rolesOf.get(e.from).push(e.to);
    }
    if (e.type === "USES_PROFILE") {
      const role = profileRole.get(e.to);
      if (role) {
        if (!rolesOf.has(e.from)) rolesOf.set(e.from, []);
        rolesOf.get(e.from).push(role);
      }
    }
  }
  const policiesOf = new Map();  // role -> [policyArn]
  for (const e of graph.edges) {
    if (e.type !== "USES_POLICY") continue;
    if (!policiesOf.has(e.from)) policiesOf.set(e.from, []);
    policiesOf.get(e.from).push(e.to);
  }
  // resource ARNs, indexed so a policy's ARN can find the node it names
  const nodeByArn = new Map();
  for (const n of graph.nodes) nodeByArn.set(arnRoot(n.id), n.id);

  for (const [compute, roles] of rolesOf) {
    for (const role of roles) {
      for (const pol of policiesOf.get(role) ?? []) {
        const doc = byId.get(pol)?.properties?.document;
        if (typeof doc !== "string") continue;
        for (const arn of resourceARNsIn(doc)) {
          const target = nodeByArn.get(arnRoot(arn));
          if (target) push(compute, target, "USES");
        }
      }
    }
  }

  // --- 2. security-group reachability, with the port that permits it -------
  const members = new Map();
  const sgsOf = new Map();
  for (const e of graph.edges) {
    if (e.type !== "ASSOC_WITH" || label(e.to) !== "SG") continue;
    if (!members.has(e.to)) members.set(e.to, []);
    members.get(e.to).push(e.from);
    const owner = resolve(e.from);
    if (!sgsOf.has(owner)) sgsOf.set(owner, []);
    sgsOf.get(owner).push(e.to);
  }
  // which ports a group's rules open to a peer group
  const portsFor = (sgId, peerId) => {
    const peerShort = String(peerId).split("/").pop();
    const hits = [];
    for (const r of parseRules(byId.get(sgId), "ingress_rules")) {
      if (r?.source_sg !== peerShort) continue;
      hits.push(spanLabel(ruleSpan(r)));
    }
    return [...new Set(hits)].slice(0, 3).join(",");
  };
  for (const e of graph.edges) {
    if (e.type !== "REFERENCES") continue;
    const ports = portsFor(e.from, e.to);
    for (const rawSrc of members.get(e.to) ?? []) {
      for (const rawDst of members.get(e.from) ?? []) {
        push(resolve(rawSrc), resolve(rawDst), "REACHES", { ports });
      }
    }
  }

  // --- 3. what the address-range rules admit -------------------------------
  // Section 2 sees group-to-group references only. That is the well-structured
  // pattern — and it is precisely the one the flat, permissive rules do not
  // use, so a diagram built from it alone draws the careful paths and hides the
  // careless ones. These are the rest: every ingress rule written as a CIDR.
  const ipOwners = [];
  for (const n of graph.nodes) {
    const p = n.properties ?? {};
    if (n.label === "ENI" && p.primary_ip) ipOwners.push([ipToInt(p.primary_ip), resolve(n.id)]);
    else if (p.private_ip) ipOwners.push([ipToInt(p.private_ip), n.id]);
  }
  // Which resources hold an address inside a range. Cached, because the same
  // handful of ranges appears on rule after rule.
  const rangeCache = new Map();
  const ownersIn = (cidr) => {
    if (rangeCache.has(cidr)) return rangeCache.get(cidr);
    const range = cidrRange(cidr);
    const hit = [];
    if (range) {
      for (const [ip, owner] of ipOwners) {
        if (ip !== null && ip >= range[0] && ip <= range[1]) hit.push(owner);
      }
    }
    const uniq = [...new Set(hit)];
    rangeCache.set(cidr, uniq);
    return uniq;
  };
  // Does this resource have a rule naming this specific port? Used to turn "may
  // reach the whole range on 8088" into "reaches the things that serve 8088".
  // All-port rules are deliberately not a match: they would make every host in
  // the range answer for every port and put the fan-out straight back.
  const servesPort = (ownerId, port) => {
    for (const sgId of sgsOf.get(ownerId) ?? []) {
      for (const r of parseRules(byId.get(sgId), "ingress_rules")) {
        const s = ruleSpan(r);
        if (!s.all && port >= s.from && port <= s.to) return true;
      }
    }
    return false;
  };

  // A range covering more than a handful of resources is drawn as one source
  // node rather than as a line per resource: "everything in this range reaches
  // this" is the claim, and a line per address states it far less clearly.
  const CIDR_FANOUT_MAX = 4;
  const sources = new Map();

  for (const sgId of members.keys()) {
    const targets = [...new Set((members.get(sgId) ?? []).map(resolve))];
    for (const r of parseRules(byId.get(sgId), "ingress_rules")) {
      const cidr = typeof r?.cidr === "string" ? r.cidr : "";
      if (!cidr) continue;
      const span = ruleSpan(r);
      const ports = spanLabel(span);

      if (isWorldCIDR(cidr) || !isPrivateCIDR(cidr)) {
        // Admission from outside the VPC. A load balancer on 80/443 is the
        // intended front door; anything else is a resource answering an outside
        // address directly, and an allowlist is better than none but is still
        // an open door on somebody else's network.
        const world = isWorldCIDR(cidr);
        for (const t of targets) {
          const frontDoor = label(t) === "LB" && spanHits(span, FRONT_DOOR_PORTS) &&
            !span.all && !spanHits(span, ADMIN_PORTS) && !spanHits(span, DATA_PORTS);
          // An allowlist is better than none, but a database port reachable
          // from outside the VPC is the data tier answering the boundary
          // directly, allowlist or not.
          const risk = frontDoor ? null : world || spanHits(span, DATA_PORTS) ? "high" : "medium";
          push(INTERNET_ID, t, "ADMITS", { ports, cidr, risk });
        }
        continue;
      }

      // An internal range: lateral reach. An all-port rule collapses the
      // segmentation every other group provides, so it is graded, not just drawn.
      const risk = span.all ? "medium" : null;
      const owners = ownersIn(cidr).filter((o) => !targets.includes(o));
      if (owners.length > CIDR_FANOUT_MAX) {
        const id = CIDR_PREFIX + cidr;
        sources.set(id, { id, cidr, count: owners.length });
        for (const t of targets) push(id, t, "REACHES", { ports, cidr, risk });
        continue;
      }
      for (const o of owners) {
        for (const t of targets) push(o, t, "REACHES", { ports, cidr, risk });
      }
    }
  }

  // --- 4. paths that leave no inbound rule at all --------------------------
  // A group that admits nothing, dials the internet, and can also reach
  // internal service ports is the shape of an outbound-established tunnel. The
  // session is opened outbound, so there is no ingress rule to draw — which is
  // exactly why this one has to be derived from egress, and why a diagram that
  // reads ingress alone shows the services behind it as unreachable.
  for (const sgId of members.keys()) {
    const sg = byId.get(sgId);
    const ingress = parseRules(sg, "ingress_rules");
    const egress = parseRules(sg, "egress_rules");
    if (!egress.length || ingress.length) continue;

    let worldOut = false;
    const servicePorts = [];
    const ranges = [];
    for (const r of egress) {
      const cidr = typeof r?.cidr === "string" ? r.cidr : "";
      if (!cidr) continue;
      if (isWorldCIDR(cidr)) { worldOut = true; continue; }
      if (!isPrivateCIDR(cidr)) continue;
      const span = ruleSpan(r);
      if (span.all || span.from !== span.to || span.from < 1024) continue;
      servicePorts.push(span.from);
      ranges.push(cidr);
    }
    if (!worldOut || !servicePorts.length) continue;

    const ports = [...new Set(servicePorts)].sort((a, b) => a - b).slice(0, 3).join(",");
    const hosts = [...new Set((members.get(sgId) ?? []).map(resolve))];
    for (const host of hosts) {
      push(INTERNET_ID, host, "TUNNELS", { ports, risk: "high" });
      // and on to whatever actually serves those ports inside the range
      for (const cidr of new Set(ranges)) {
        for (const o of ownersIn(cidr)) {
          if (hosts.includes(o)) continue;
          for (const p of new Set(servicePorts)) {
            if (servesPort(o, p)) push(host, o, "TUNNELS", { ports: String(p), risk: "high" });
          }
        }
      }
    }
  }

  // --- 5. request path through the load balancer ---------------------------
  for (const e of graph.edges) {
    if (e.type === "FORWARDS") push(resolve(e.from), resolve(e.to), "FORWARDS");
  }

  // --- 6. the internet, so the diagram starts where requests do ------------
  for (const n of graph.nodes) {
    if (n.label !== "LB") continue;
    if (String(n.properties?.scheme ?? "") !== "internet-facing") continue;
    push(INTERNET_ID, n.id, "FORWARDS");
  }

  // --- 7. what a schedule or an event fires --------------------------------
  // A rule's target is a stated fact — the rule names it — so this needs no
  // inference. The distinction worth drawing is whether the rule is switched
  // on, because a DISABLED one leaves every resource it drives looking healthy.
  // Targets the scanner does not collect (SNS topics, log groups) have no node
  // to point at, so they are skipped rather than left dangling.
  for (const e of graph.edges) {
    if (e.type !== "TRIGGERS") continue;
    const rule = byId.get(e.from);
    if (!rule) continue;
    const target = resolve(e.to);
    if (!byId.has(target)) continue;
    const live = rule.properties?.state !== "DISABLED";
    push(e.from, target, live ? "FIRES" : "DORMANT");
  }

  // --- 8. bundle: one line per pair, carrying how many grants it represents -
  // A rule naming its target outranks an IAM grant to the same pair: both are
  // real, but "this fires it" is the more specific claim.
  const RANK = { TUNNELS: 7, FIRES: 6, USES: 5, ADMITS: 4, FORWARDS: 3, DORMANT: 2, REACHES: 1 };
  const RISK = { high: 2, medium: 1 };
  const bundled = new Map();
  for (const e of edges) {
    const k = `${e.from}->${e.to}`;
    const prev = bundled.get(k);
    if (!prev) { bundled.set(k, { ...e, count: 1 }); continue; }
    // A real dependency outranks mere reachability between the same two nodes —
    // but the worst risk among them is what the line should be coloured by,
    // whichever claim ends up drawn.
    const risk = (RISK[e.risk] ?? 0) > (RISK[prev.risk] ?? 0) ? e.risk : prev.risk;
    if ((RANK[e.type] ?? 0) > (RANK[prev.type] ?? 0)) {
      bundled.set(k, { ...e, risk, count: prev.count + 1 });
    } else {
      prev.risk = risk;
      prev.count += 1;
    }
  }
  return { edges: [...bundled.values()], sources: [...sources.values()] };
}

// The second line of a node box normally repeats its type, which the icon and
// the colour already carry. For a rule that line is the only place the two
// things a reader needs can go: when it fires, and whether it is switched on.
function tierNodeLabel(n) {
  if (n.label !== "EVENTBRIDGERULE") return n.label;
  const p = n.properties ?? {};
  const when = p.schedule ?? (p.event_driven ? "on event" : "no schedule");
  return p.state === "DISABLED" ? `${when} · DISABLED` : when;
}

function layoutTiered(graph, opts) {
  const { overlayByKey, region, sources, tiers = TIERS, origins } = opts;
  const appOf = makeAppOf(graph.nodes.map((n) => n.name));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // Only roles that actually take part in a trust relationship are drawn;
  // otherwise the identity tier is hundreds of boxes nobody reads.
  const inTrust = new Set();
  for (const e of graph.edges) {
    if (e.type !== "TRUSTS") continue;
    inTrust.add(e.from);
    inTrust.add(e.to);
  }

  const tierOf = (n) => {
    if (n.label === "IAMROLE") return inTrust.has(n.id) ? "identity" : null;
    for (const t of tiers) {
      if (t.labels.includes(n.label)) return t.id;
    }
    return null;
  };

  // account -> tier -> nodes
  const lanes = new Map();
  for (const n of graph.nodes) {
    const tier = tierOf(n);
    if (!tier) continue;
    const acct = n.account_id || "unknown";
    if (!lanes.has(acct)) lanes.set(acct, new Map());
    const byTier = lanes.get(acct);
    if (!byTier.has(tier)) byTier.set(tier, []);
    byTier.get(tier).push(n);
  }

  const out = [];
  const COLS = 2;
  let laneY = 0;

  // Requests start somewhere. Without this the edge tier looks like an origin
  // rather than a boundary.
  const wantInternet = origins !== false;
  if (wantInternet) {
    out.push({
      id: INTERNET_ID, type: "aws", position: { x: 0, y: 0 },
      style: { width: A_NODE_W, height: A_NODE_H }, width: A_NODE_W, height: A_NODE_H,
      data: { name: "Internet", label: "PUBLIC", resourceLabel: "PUBLIC", accentColor: "#f87171", title: "Public internet" },
    });
  }

  // A range that reaches half the estate is one origin, not a hundred lines out
  // of a hundred boxes. Drawn beside the internet because it is the same kind of
  // thing: somewhere traffic comes from that is not a resource on the diagram.
  let sx = wantInternet ? A_NODE_W + A_GAP : 0;
  for (const s of sources ?? []) {
    out.push({
      id: s.id, type: "aws", position: { x: sx, y: 0 },
      style: { width: A_NODE_W, height: A_NODE_H }, width: A_NODE_W, height: A_NODE_H,
      data: {
        name: s.cidr, label: `RANGE · ${s.count} resources`, resourceLabel: "CIDR",
        accentColor: "#fbbf24",
        title: `${s.cidr}\n${s.count} resources hold an address in this range`,
      },
    });
    sx += A_NODE_W + A_GAP;
  }
  if (wantInternet || sx > 0) laneY += A_NODE_H + 24;

  for (const acct of [...lanes.keys()].sort()) {
    const byTier = lanes.get(acct);
    const boxes = tiers.map((t) => {
      const items = byTier.get(t.id) ?? [];
      // A tier with 25 ECR repositories should not become a 25-row column while
      // the edge tier next to it holds three.
      const cols = Math.max(COLS, Math.min(5, Math.ceil(Math.sqrt(items.length || 1))));
      const g = gridSize(items.length || 1, cols, A_NODE_W, A_NODE_H, A_GAP);
      return { t, items, g, w: g.w + 2 * A_TIER_PADX, h: A_TIER_HEAD + g.h + A_TIER_PADB };
    });
    const innerW = boxes.reduce((a, b) => a + b.w, 0) + (boxes.length - 1) * A_GAP;
    const innerH = Math.max(...boxes.map((b) => b.h));
    const laneH = A_LANE_HEAD2 + innerH + A_LANE_PADB;

    out.push({
      id: `__lane__${acct}`, type: "group", position: { x: 0, y: laneY },
      style: { width: innerW + 2 * A_LANE_PADX, height: laneH },
      selectable: false, draggable: false, zIndex: 0,
      data: {
        title: `Account ${acct}`,
        subtitle: region ? `${region}   ·   traffic flows left to right` : "traffic flows left to right",
        fill: "rgba(99,102,241,0.04)", stroke: "#6366f1",
      },
    });

    let tx = 0;
    for (const b of boxes) {
      const tid = `__tier__${acct}__${b.t.id}`;
      out.push({
        id: tid, type: "group", parentId: `__lane__${acct}`, extent: "parent",
        position: { x: A_LANE_PADX + tx, y: A_LANE_HEAD2 },
        style: { width: b.w, height: innerH },
        selectable: false, draggable: false, zIndex: 1,
        data: {
          title: b.t.title, subtitle: `${b.items.length} · ${b.t.hint}`,
          fill: "rgba(148,163,184,0.04)", stroke: "#475569", borderStyle: "dashed", borderWidth: 1,
        },
      });
      // Within a tier, keep a workload's resources adjacent: reading "here is
      // community-upload end to end" beats reading "here are all the Lambdas".
      const ordered = [...b.items].sort((x, y) => {
        const ax = appOf(x.name), ay = appOf(y.name);
        return ax === ay ? String(x.name).localeCompare(String(y.name)) : ax.localeCompare(ay);
      });
      ordered.forEach((n, i) => {
        const c = i % b.g.cols, r = Math.floor(i / b.g.cols);
        const ov = overlayByKey?.get(n.id);
        out.push({
          id: n.id, type: "aws", parentId: tid, extent: "parent",
          position: { x: A_TIER_PADX + c * (A_NODE_W + A_GAP), y: A_TIER_HEAD + r * (A_NODE_H + A_GAP) },
          style: { width: A_NODE_W, height: A_NODE_H },
          width: A_NODE_W, height: A_NODE_H,
          data: {
            name: n.name || n.id.split("/").pop().split(":").pop(),
            label: tierNodeLabel(n), marker: ov === "add" ? "+ " : ov === "mod" ? "~ " : "",
            resourceLabel: n.label, icon: iconFor(n.label, n.properties), iconKey: iconKey(n.label, n.properties),
            accentColor: ov === "add" ? "#4ade80" : ov === "mod" ? "#fbbf24" : (COLORS[n.label] ?? "#475569"),
            emphasised: Boolean(ov),
            title: `${n.name || ""}\n${n.label}\n${n.id}`,
          },
        });
      });
      tx += b.w + A_GAP;
    }
    laneY += laneH + 30;
  }
  return out;
}

// Containment is drawn as nesting in the architecture view, so those edges would
// just be noise on top of it.
// TRIGGERS joins them for a different reason: the architecture view replaces it
// with the richer FIRES/DORMANT claim, and the component view is a containment
// diagram that draws no edges at all — a rule's raw target line would be the
// only one on it.
const ARCH_HIDDEN_EDGES = new Set(["IN_VPC", "IN_SUBNET", "PART_OF", "CONTAINS", "TRIGGERS"]);

function layoutGraph(nodes, edges) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 60, ranksep: 240 });
  nodes.forEach((n) => g.setNode(n.id, { width: 210, height: 56 }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id) || { x: 0, y: 0 };
    return { ...n, position: { x: p.x, y: p.y } };
  });
}

function Diagram({ graph, findingsGraph, diffOverlay, view, region, findings, ensureDrift, exportRef }) {
  if (!graph) {
    return h("div", { className: "flex h-full items-center justify-center text-sm text-slate-500" },
      h("div", { className: "h-6 w-6 animate-spin rounded-full border-2 border-white/10 border-t-sky-400" }));
  }
  // The drift payload groups resources by what happened to them; it has no flat
  // `nodes` list, so reading one marked nothing at all. Removed resources are
  // absent from the current graph, so only added and changed can be marked.
  const overlayByKey = useMemo(() => {
    const m = new Map();
    for (const n of diffOverlay?.nodes_added?.items ?? []) m.set(n.key, "add");
    for (const n of diffOverlay?.nodes_changed?.items ?? []) m.set(n.key, "mod");
    return m;
  }, [diffOverlay]);
  const findNodes = useMemo(() => (findingsGraph?.nodes ?? []).map((n) => ({
    id: n.id, type: "default",
    data: { label: `${n.name}\n[finding]`, resourceLabel: "Finding" },
    style: { background: FIND_COLORS[n.tags?.severity] ?? "#475569", color: "#fff", border: "1px dashed #fff", borderRadius: 4, padding: "6px 10px", fontSize: 11, fontFamily: "monospace", whiteSpace: "pre-line" },
  })), [findingsGraph]);
  const findEdges = useMemo(() => (findingsGraph?.edges ?? []).map((e, i) => ({
    id: `affect-${i}`, source: e.from, target: e.to, type: "default", animated: true,
    markerEnd: { type: MarkerType.ArrowClosed, color: "#fb7185", width: 14, height: 14 },
    style: { stroke: "#fb7185", strokeDasharray: "4 3" }, labelStyle: { fontSize: 0 },
  })), [findingsGraph]);
  const nodeIds = useMemo(() => new Set(graph.nodes.map((n) => n.id)), [graph]);
  const dagreNodes = useMemo(() =>
    graph.nodes.map((n) => {
      const ov = overlayByKey.get(n.id);
      const name = n.name || n.id.split("/").pop();
      const marker = ov === "add" ? "+ " : ov === "mod" ? "~ " : "";
      return {
        id: n.id, type: "aws",
        // matches the box dagre reserves in layoutGraph
        style: { width: 210, height: 56 },
        width: 210, height: 56,
        data: {
          name,
          label: n.label,
          marker,
          resourceLabel: n.label,
          icon: iconFor(n.label, n.properties), iconKey: iconKey(n.label, n.properties),
          // drift overlay keeps its green/amber emphasis
          accentColor: ov === "add" ? "#4ade80" : ov === "mod" ? "#fbbf24" : (COLORS[n.label] ?? "#475569"),
          emphasised: Boolean(ov),
          title: `${name}\n${n.label}\n${n.id}`,
        },
      };
    }),
  [graph, overlayByKey]);
  const dagreEdges = useMemo(() =>
    graph.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)).map((e) => ({
      id: `${e.from}→${e.to}→${e.type}`, source: e.from, target: e.to, type: "default",
      animated: e.type === "REFERENCES" || e.type === "FLOWS_ON",
      markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8", width: 16, height: 16 },
      style: e.type === "REFERENCES" ? { stroke: "#f97316", strokeDasharray: "5 5" } : { stroke: "#475569" },
      labelStyle: { fontSize: 0 },
    })),
  [graph, nodeIds]);
  const allNodes = useMemo(() => [...dagreNodes, ...findNodes], [dagreNodes, findNodes]);
  const allEdges = useMemo(() => [...dagreEdges, ...findEdges], [dagreEdges, findEdges]);
  const layoutedNodes = useMemo(() => layoutGraph(allNodes, allEdges), [allNodes, allEdges]);

  // Derived before layout, because the wide address ranges it finds become
  // origin nodes the layout has to place.
  // The attack-path view walks the same derived edges the architecture view
  // draws, so both need the derivation.
  const derivation = useMemo(
    () => (view === "arch" || view === "attack" ? deriveArchEdges(graph) : { edges: [], sources: [] }),
    [view, graph],
  );
  // The four extra views build their own nodes and edges together, because in
  // each of them the layout depends on what the edges turned out to be.
  const built = useMemo(() => {
    const opts = { overlayByKey, region, findings, derived: derivation.edges };
    if (view === "dataflow") return buildDataFlow(graph, opts);
    if (view === "attack") return buildAttackPaths(graph, opts);
    if (view === "network") return buildNetwork(graph, opts);
    if (view === "accounts") return buildAccounts(graph, opts);
    return null;
  }, [view, graph, overlayByKey, region, findings, derivation]);

  const archNodes = useMemo(
    () =>
      built
        ? built.nodes
        : view === "component"
        ? layoutArchitecture(graph, { overlayByKey, region })
        : view === "arch"
        ? layoutTiered(graph, { overlayByKey, region, sources: derivation.sources })
        : [],
    [view, graph, overlayByKey, region, derivation, built],
  );
  const archEdges = useMemo(() => {
    if (view === "flow" || view === "findings") return [];
    const drawn = new Set(archNodes.map((n) => n.id));
    // A view that builds its own edges has already decided what belongs; the
    // collected graph edges would be about other nodes entirely.
    if (built) {
      return built.edges.filter((e) => drawn.has(e.from) && drawn.has(e.to)).map(styleClaim);
    }
    const derived = derivation.edges;
    // An edge pointing at a container the source already sits inside (an
    // internet gateway ATTACHED_TO its VPC) loops from inside the box back to
    // its own border. Nesting already states it.
    const containers = new Set(
      graph.nodes.filter((n) => n.label === "VPC" || n.label === "SUBNET").map((n) => n.id),
    );
    return [...graph.edges, ...derived]
      .filter((e) => !ARCH_HIDDEN_EDGES.has(e.type) && drawn.has(e.from) && drawn.has(e.to))
      .filter((e) => !containers.has(e.to) && !containers.has(e.from))
      // The architecture view is about the request/trust path, so it draws only
      // edges that represent one; the component view keeps the rest.
      .filter((e) => view !== "arch" || ARCH_CLAIMS.includes(e.type))
      .map(styleClaim);
  }, [view, graph, archNodes, derivation, built]);

  const isLaidOut = view !== "flow";
  const [selected, setSelected] = useState(null);

  // ---- focus mode -----------------------------------------------------------
  // An architecture diagram with 257 edges is unreadable all at once. Two things
  // reduce it: resources nothing connects to are dimmed from the start (they are
  // inventory, not part of any path), and selecting one resource dims everything
  // that is not on one of its connections.
  const connected = useMemo(() => {
    const set = new Set();
    for (const e of archEdges) { set.add(e.source); set.add(e.target); }
    return set;
  }, [archEdges]);

  const neighbourhood = useMemo(() => {
    if (!selected) return null;
    const nodes = new Set([selected]);
    const edges = new Set();
    for (const e of archEdges) {
      if (e.source === selected || e.target === selected) {
        edges.add(e.id);
        nodes.add(e.source);
        nodes.add(e.target);
      }
    }
    return { nodes, edges };
  }, [selected, archEdges]);

  const DIM = 0.16;
  const focusedNodes = useMemo(() => {
    // Derived views only. The component view answers "what runs where" and has
    // no edges, so dimming by connectivity there fades the entire diagram.
    if (!DERIVED_VIEWS.has(view)) return archNodes;
    return archNodes.map((n) => {
      if (n.type === "group") return n;
      // With a selection, anything off its connections recedes. Without one,
      // only resources that connect to nothing recede.
      const lit = neighbourhood ? neighbourhood.nodes.has(n.id) : connected.has(n.id);
      if (lit) return n;
      return { ...n, style: { ...(n.style ?? {}), opacity: DIM } };
    });
  }, [view, archNodes, neighbourhood, connected]);

  const focusedEdges = useMemo(() => {
    if (!DERIVED_VIEWS.has(view) || !neighbourhood) return archEdges;
    return archEdges.map((e) =>
      neighbourhood.edges.has(e.id)
        ? { ...e, style: { ...(e.style ?? {}), opacity: 1, strokeWidth: (e.style?.strokeWidth ?? 1.4) + 0.6 }, animated: true }
        : { ...e, style: { ...(e.style ?? {}), opacity: 0.07 }, label: undefined },
    );
  }, [view, archEdges, neighbourhood]);


  // A node that vanishes between views (or between snapshots) must not leave a
  // stale panel open.
  // Attack-path nodes are lane-local (`__path__0|arn:…`) so one resource can
  // appear on several paths; the panel still has to find the real resource.
  const realId = (id) => (String(id).includes("|") ? String(id).slice(String(id).indexOf("|") + 1) : id);
  const nodeById = useMemo(() => {
    const m = new Map(graph.nodes.map((n) => [n.id, n]));
    return { get: (id) => m.get(id) ?? m.get(realId(id)), has: (id) => m.has(id) || m.has(realId(id)) };
  }, [graph]);
  useEffect(() => { setSelected(null); }, [view]);

  const selectedNode = selected && nodeById.has(selected)
    ? { ...nodeById.get(selected), icon: iconFor(nodeById.get(selected).label, nodeById.get(selected).properties) }
    : null;

  // Every glyph the graph can show, so the palette covers views not on screen.
  const iconKeys = useMemo(
    () => [...new Set(graph.nodes.map((n) => iconKey(n.label, n.properties)).filter(Boolean))].sort(),
    [graph],
  );

  // Laid out on demand rather than kept in state: "export all" is a rare click,
  // and holding seven layouts alive to serve it would cost on every render.
  const buildAllViews = () => {
    const opts = { overlayByKey, region, findings };
    const arch = deriveArchEdges(graph);
    const styled = (es, ns) => {
      const drawn = new Set(ns.map((n) => n.id));
      return es.filter((e) => drawn.has(e.from) && drawn.has(e.to)).map(styleClaim);
    };
    const out = [];
    for (const v of DIAGRAM_VIEWS) {
      if (v === "flow") continue; // a dependency dump, not a document
      let ns = [], es = [];
      if (v === "component") {
        ns = layoutArchitecture(graph, opts);
      } else if (v === "arch") {
        ns = layoutTiered(graph, { ...opts, sources: arch.sources });
        es = styled(arch.edges, ns);
      } else {
        const built = v === "dataflow" ? buildDataFlow(graph, { ...opts, derived: arch.edges })
          : v === "attack" ? buildAttackPaths(graph, { ...opts, derived: arch.edges })
          : v === "network" ? buildNetwork(graph, opts)
          : buildAccounts(graph, opts);
        ns = built.nodes;
        es = styled(built.edges, ns);
      }
      if (ns.length) out.push({ id: v, label: VIEW_LABEL[v], hint: VIEW_HINT[v], nodes: ns, edges: es });
    }
    return out;
  };

  const onNodeClick = (_e, n) => {
    // Containers carry no resource of their own; clicking one should not open a
    // panel describing a boundary.
    if (n?.type === "group") { setSelected(null); return; }
    setSelected(n?.id ?? null);
  };

  return h(ReactFlowProvider, null,
    h(FlowCanvas, {
      nodes: isLaidOut ? focusedNodes : layoutedNodes,
      edges: isLaidOut ? focusedEdges : allEdges,
      overlayByKey, COLORS, viewKey: view,
      onNodeClick,
      onPaneClick: () => setSelected(null),
      detail: h(DetailPanel, { node: selectedNode, findings, onClose: () => setSelected(null) }),
      canExport: isLaidOut,
      findings,
      ensureDrift,
      exportRef,
      nodeById: (id) => nodeById.get(id),
      iconKeys,
      buildAllViews,
      exportTitle: `AWS ${VIEW_LABEL[view] ?? view} diagram${region ? ` — ${region}` : ""}`,
      exportAllTitle: `AWS infrastructure report${region ? ` — ${region}` : ""}`,
      exportFooter: `${graph.nodes.length} resources · generated by AWSome`,
    }),
  );
}

/* ============================================================ */
/*  ADDITIONAL VIEWS                                              */
/*  Each builder answers one question the others cannot, and      */
/*  returns { nodes, edges } in the same shape the architecture    */
/*  view produces, so styling, focus and export apply unchanged.   */
/* ============================================================ */

const STORE_LABELS = ["S3BUCKET", "RDS", "DYNAMODBTABLE", "ELASTICACHE", "ECRREPOSITORY", "REDSHIFT", "OPENSEARCH"];
const COMPUTE_LABELS = ["EC2", "LAMBDA", "ECSCLUSTER", "EKS", "ASG"];

const DATA_TIERS = [
  { id: "workload", title: "Workloads", hint: "what holds the credentials", labels: COMPUTE_LABELS },
  { id: "store", title: "Data stores", hint: "what holds the data", labels: STORE_LABELS },
];

// Verb classification. An IAM action is `service:Verb…`, and the verb is what
// decides whether a grant can read data, change it, or do anything at all.
const WRITE_VERB = /^(Put|Post|Create|Update|Delete|Write|Upload|Copy|Restore|Abort|Complete|Replicate|Tag|Untag|Set|Modify|Import|Invalidate|Start|Stop|Run|Reboot|Attach|Detach|Associate|Disassociate|Add|Remove|Purge|Truncate|Register|Deregister)/;
const READ_VERB = /^(Get|List|Describe|Query|Scan|Head|Select|Read|Batch(Get|Read)|Estimate|Preview|Search|Lookup|Discover)/;

// grantsOn walks a policy document and reports what it permits on each resource
// ARN it names, as a set of "read" | "write" | "admin".
function grantsOn(doc) {
  const out = new Map(); // arnRoot -> Set
  let parsed;
  try { parsed = JSON.parse(doc); } catch { return out; }
  for (const st of (Array.isArray(parsed?.Statement) ? parsed.Statement : [])) {
    if (String(st?.Effect ?? "").toLowerCase() !== "allow") continue;
    const acts = Array.isArray(st.Action) ? st.Action : st.Action ? [st.Action] : [];
    const res = Array.isArray(st.Resource) ? st.Resource : st.Resource ? [st.Resource] : [];
    const kinds = new Set();
    for (const a of acts) {
      if (typeof a !== "string") continue;
      const verb = a.includes(":") ? a.slice(a.indexOf(":") + 1) : a;
      if (a === "*" || verb === "*") { kinds.add("admin"); continue; }
      if (WRITE_VERB.test(verb)) kinds.add("write");
      else if (READ_VERB.test(verb)) kinds.add("read");
      else kinds.add("write"); // an unrecognised verb is assumed to be able to change something
    }
    if (!kinds.size) continue;
    for (const r of res) {
      if (typeof r !== "string" || r === "*" || !r.startsWith("arn:")) continue;
      const k = arnRoot(r);
      if (!out.has(k)) out.set(k, new Set());
      for (const x of kinds) out.get(k).add(x);
    }
  }
  return out;
}

// computeRoles maps each compute resource to the roles it runs as. Shared by
// the data-flow view and anything else that needs "what can this host do".
function computeRoles(graph) {
  const profileRole = new Map();
  for (const e of graph.edges) if (e.type === "HAS_ROLE") profileRole.set(e.from, e.to);
  const rolesOf = new Map();
  const add = (k, v) => { if (!rolesOf.has(k)) rolesOf.set(k, []); rolesOf.get(k).push(v); };
  for (const e of graph.edges) {
    if (e.type === "USES_ROLE") add(e.from, e.to);
    if (e.type === "USES_PROFILE") { const r = profileRole.get(e.to); if (r) add(e.from, r); }
  }
  return rolesOf;
}

/* ---------- data flow ----------
 * The architecture view says a workload uses a store. This one says what it is
 * allowed to do with it, which is the difference between a reader and something
 * that can delete the evidence.
 */
function buildDataFlow(graph, opts) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodeByArn = new Map();
  for (const n of graph.nodes) nodeByArn.set(arnRoot(n.id), n.id);

  const policiesOf = new Map();
  for (const e of graph.edges) {
    if (e.type !== "USES_POLICY") continue;
    if (!policiesOf.has(e.from)) policiesOf.set(e.from, []);
    policiesOf.get(e.from).push(e.to);
  }

  const seen = new Map(); // "from->to" -> Set of kinds
  for (const [compute, roles] of computeRoles(graph)) {
    if (!byId.has(compute)) continue;
    for (const role of roles) {
      for (const pol of policiesOf.get(role) ?? []) {
        const doc = byId.get(pol)?.properties?.document;
        if (typeof doc !== "string") continue;
        for (const [arn, kinds] of grantsOn(doc)) {
          const target = nodeByArn.get(arn);
          if (!target || target === compute) continue;
          if (!STORE_LABELS.includes(byId.get(target)?.label)) continue;
          const k = `${compute}->${target}`;
          if (!seen.has(k)) seen.set(k, new Set());
          for (const x of kinds) seen.get(k).add(x);
        }
      }
    }
  }

  const edges = [];
  for (const [k, kinds] of seen) {
    const [from, to] = k.split("->");
    const type = kinds.has("admin") ? "ADMINS" : kinds.has("write") ? "WRITES" : "READS";
    const label = kinds.has("admin") ? "*" : (kinds.has("read") ? "r" : "") + (kinds.has("write") ? "w" : "");
    edges.push({ from, to, type, ports: label, risk: kinds.has("admin") ? "high" : null });
  }
  return {
    nodes: layoutTiered(graph, { ...opts, tiers: DATA_TIERS, origins: false, sources: [] }),
    edges,
  };
}

/* ---------- attack paths ----------
 * Everything else draws the estate and leaves the reader to trace a route
 * through it. This draws the routes: one lane per way in, each one a chain from
 * the internet to something worth reaching.
 */
const ATTACK_MAX_PATHS = 10;
const ATTACK_MAX_HOPS = 5;

function buildAttackPaths(graph, opts) {
  const { findings, derived } = opts;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const worst = new Map(); // node -> severity rank
  const SEV = { critical: 4, high: 3, medium: 2, low: 1 };
  const ruleOn = new Map();
  for (const f of findings ?? []) {
    if (f.suppressed) continue;
    const r = SEV[f.severity] ?? 0;
    if (r > (worst.get(f.resource_key) ?? 0)) { worst.set(f.resource_key, r); ruleOn.set(f.resource_key, f.rule); }
  }

  const next = new Map();
  for (const e of derived ?? []) {
    if (!next.has(e.from)) next.set(e.from, []);
    next.get(e.from).push(e);
  }

  // Depth-first from the internet, stopping at a data store or at the hop
  // limit. Each distinct endpoint keeps only its shortest route: the point is
  // how something is reached, not every way of reaching it.
  const best = new Map();
  const walk = (node, chain, visited) => {
    if (chain.length > ATTACK_MAX_HOPS) return;
    const label = byId.get(node)?.label;
    if (chain.length && STORE_LABELS.includes(label)) {
      const prev = best.get(node);
      if (!prev || chain.length < prev.length) best.set(node, chain);
      return;
    }
    for (const e of next.get(node) ?? []) {
      if (visited.has(e.to)) continue;
      walk(e.to, [...chain, e], new Set([...visited, e.to]));
    }
    // A chain that reaches compute and goes no further is still a way in.
    if (chain.length && COMPUTE_LABELS.includes(label) && !best.has(node)) best.set(node, chain);
  };
  walk(INTERNET_ID, [], new Set([INTERNET_ID]));

  const score = (chain) => chain.reduce((a, e) =>
    a + (e.risk === "high" ? 3 : e.risk === "medium" ? 1 : 0) + (worst.get(e.to) ?? 0), 0);
  const paths = [...best.values()].sort((a, b) => score(b) - score(a) || a.length - b.length)
    .slice(0, ATTACK_MAX_PATHS);

  // One lane per path, hops left to right.
  const nodes = [];
  const edges = [];
  const W = A_NODE_W, H = A_NODE_H, GX = 64, GY = 26, PADX = 18, HEAD = 54;
  let y = 0;
  paths.forEach((chain, i) => {
    const hops = [INTERNET_ID, ...chain.map((e) => e.to)];
    const laneId = `__path__${i}`;
    const laneW = PADX * 2 + hops.length * W + (hops.length - 1) * GX;
    const sev = score(chain);
    nodes.push({
      id: laneId, type: "group", position: { x: 0, y },
      style: { width: laneW, height: HEAD + H + 16 },
      selectable: false, draggable: false, zIndex: 0,
      data: {
        title: `Path ${i + 1} — ${hops.length - 1} hop${hops.length === 2 ? "" : "s"} to ${byId.get(hops[hops.length - 1])?.name ?? "?"}`,
        subtitle: chain.map((e) => e.type.toLowerCase()).join(" → "),
        fill: sev >= 6 ? "rgba(248,113,113,0.05)" : "rgba(148,163,184,0.04)",
        stroke: sev >= 6 ? "#f87171" : sev >= 3 ? "#fbbf24" : "#475569",
      },
    });
    hops.forEach((id, j) => {
      const src = byId.get(id);
      const ov = opts.overlayByKey?.get(id);
      // A node can appear on more than one path, so ids are made lane-local.
      nodes.push({
        id: `${laneId}|${id}`, type: "aws", parentId: laneId, extent: "parent",
        position: { x: PADX + j * (W + GX), y: HEAD },
        style: { width: W, height: H }, width: W, height: H,
        data: {
          name: src?.name || (id === INTERNET_ID ? "Internet" : String(id).split("/").pop()),
          label: ruleOn.get(id) ?? (src?.label ?? "PUBLIC"),
          resourceLabel: src?.label ?? "PUBLIC",
          icon: src ? iconFor(src.label, src.properties) : undefined, iconKey: iconKey(src?.label, src?.properties),
          accentColor: worst.get(id) >= 3 ? "#f87171" : worst.get(id) ? "#fbbf24" : (COLORS[src?.label] ?? "#475569"),
          emphasised: Boolean(worst.get(id)) || Boolean(ov),
          title: `${src?.name ?? "Internet"}\n${src?.label ?? ""}\n${id}`,
        },
      });
      if (j) edges.push({ from: `${laneId}|${hops[j - 1]}`, to: `${laneId}|${id}`, type: chain[j - 1].type, ports: chain[j - 1].ports, risk: chain[j - 1].risk });
    });
    y += HEAD + H + 16 + GY;
  });

  if (!paths.length) {
    nodes.push({
      id: "__nopath__", type: "group", position: { x: 0, y: 0 },
      style: { width: 560, height: 88 }, selectable: false, draggable: false,
      data: { title: "No path found from the internet to a data store", subtitle: "Nothing admits an outside address, or nothing reachable leads anywhere", fill: "rgba(52,211,153,0.05)", stroke: "#34d399" },
    });
  }
  return { nodes, edges };
}

/* ---------- network topology ----------
 * Subnets grouped by availability zone, public or private by the only thing
 * that actually decides it: whether a route table attached to the subnet has a
 * route to an internet gateway.
 */
function buildNetwork(graph, opts) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const subnets = graph.nodes.filter((n) => n.label === "SUBNET");
  const vpcs = graph.nodes.filter((n) => n.label === "VPC");

  // route table -> does it reach an internet gateway
  const rtToIgw = new Map();
  for (const e of graph.edges) {
    if (e.type === "ROUTES_TO" && byId.get(e.to)?.label === "IGW") rtToIgw.set(e.from, e.to);
  }
  const rtOfSubnet = new Map();
  for (const e of graph.edges) {
    if (e.type === "APPLIES_TO" && byId.get(e.to)?.label === "SUBNET") {
      if (!rtOfSubnet.has(e.to)) rtOfSubnet.set(e.to, []);
      rtOfSubnet.get(e.to).push(e.from);
    }
  }
  const igwOfVpc = new Map();
  for (const e of graph.edges) {
    if (e.type === "ATTACHED_TO" && byId.get(e.from)?.label === "IGW") igwOfVpc.set(e.to, e.from);
  }
  // what sits in each subnet, so a subnet is not an empty box
  const tenants = new Map();
  for (const e of graph.edges) {
    if (e.type !== "IN_SUBNET") continue;
    const l = byId.get(e.from)?.label;
    if (l === "ENI") continue; // collapsed into their owners everywhere else
    tenants.set(e.to, (tenants.get(e.to) ?? 0) + 1);
  }

  const publicSubnet = (id) => (rtOfSubnet.get(id) ?? []).some((rt) => rtToIgw.has(rt));

  const nodes = [];
  const edges = [];
  const W = A_NODE_W, H = A_NODE_H, GAP = A_GAP, PADX = 16, VHEAD = 52, ZHEAD = 38, ZPAD = 14;
  let vy = 0;

  for (const vpc of [...vpcs].sort((a, b) => String(a.account_id).localeCompare(String(b.account_id)))) {
    const mine = subnets.filter((s) => s.properties?.vpc_id === String(vpc.id).split("/").pop() ||
      graph.edges.some((e) => e.type === "IN_VPC" && e.from === s.id && e.to === vpc.id));
    if (!mine.length) continue;
    const zones = new Map();
    for (const s of mine) {
      const az = s.properties?.az || "unknown";
      if (!zones.has(az)) zones.set(az, []);
      zones.get(az).push(s);
    }
    const zoneList = [...zones.keys()].sort();
    const rows = Math.max(...zoneList.map((z) => zones.get(z).length));
    const zoneW = W + ZPAD * 2;
    const vpcW = PADX * 2 + zoneList.length * zoneW + (zoneList.length - 1) * GAP;
    const zoneH = ZHEAD + rows * H + (rows - 1) * GAP + ZPAD;
    const vpcH = VHEAD + zoneH + 16;

    const igw = igwOfVpc.get(vpc.id);
    nodes.push({
      id: vpc.id, type: "group", position: { x: 0, y: vy },
      style: { width: vpcW, height: vpcH }, selectable: false, draggable: false, zIndex: 0,
      data: {
        title: `${vpc.name || String(vpc.id).split("/").pop()}   ${vpc.properties?.cidr_block ?? ""}`,
        subtitle: `account ${vpc.account_id ?? "?"}${vpc.properties?.default_vpc === true || vpc.properties?.default_vpc === "true" ? "   ·   DEFAULT VPC" : ""}${igw ? "   ·   internet gateway attached" : "   ·   no internet gateway"}`,
        fill: "rgba(99,102,241,0.04)", stroke: vpc.properties?.default_vpc === true || vpc.properties?.default_vpc === "true" ? "#fbbf24" : "#6366f1",
      },
    });

    zoneList.forEach((az, zi) => {
      const zid = `__az__${vpc.id}__${az}`;
      nodes.push({
        id: zid, type: "group", parentId: vpc.id, extent: "parent",
        position: { x: PADX + zi * (zoneW + GAP), y: VHEAD },
        style: { width: zoneW, height: zoneH }, selectable: false, draggable: false, zIndex: 1,
        data: { title: az, subtitle: `${zones.get(az).length} subnet(s)`, fill: "rgba(148,163,184,0.04)", stroke: "#475569", borderStyle: "dashed", borderWidth: 1 },
      });
      zones.get(az).sort((a, b) => String(a.properties?.cidr_block).localeCompare(String(b.properties?.cidr_block)))
        .forEach((s, si) => {
          const pub = publicSubnet(s.id);
          const n = tenants.get(s.id) ?? 0;
          nodes.push({
            id: s.id, type: "aws", parentId: zid, extent: "parent",
            position: { x: ZPAD, y: ZHEAD + si * (H + GAP) },
            style: { width: W, height: H }, width: W, height: H,
            data: {
              name: s.properties?.cidr_block || s.name,
              label: `${pub ? "PUBLIC" : "private"} · ${n} resource${n === 1 ? "" : "s"}`,
              resourceLabel: "SUBNET", icon: iconFor("SUBNET", s.properties), iconKey: iconKey("SUBNET", s.properties),
              accentColor: pub ? "#fbbf24" : "#38bdf8",
              emphasised: pub,
              title: `${s.properties?.cidr_block ?? ""}\n${pub ? "public — a route table on this subnet reaches an internet gateway" : "private"}\n${s.id}`,
            },
          });
          if (pub && igw) edges.push({ from: igw, to: s.id, type: "ROUTES", ports: "0.0.0.0/0", risk: "medium" });
        });
    });

    if (igw) {
      nodes.push({
        id: igw, type: "aws", position: { x: vpcW + 40, y: vy + VHEAD },
        style: { width: W, height: H }, width: W, height: H,
        data: { name: byId.get(igw)?.name || "internet gateway", label: "IGW", resourceLabel: "IGW", icon: iconFor("IGW", {}), iconKey: iconKey("IGW", {}), accentColor: "#fbbf24", title: igw },
      });
    }
    vy += vpcH + 30;
  }
  return { nodes, edges };
}

/* ---------- cross-account map ----------
 * Only what crosses an account boundary. Everything inside one is the subject
 * of every other view; the question here is which tenant can reach into which,
 * and through what.
 */
function buildAccounts(graph, opts) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const accounts = [...new Set(graph.nodes.map((n) => n.account_id).filter(Boolean))];
  const acctOf = (id) => byId.get(id)?.account_id;

  // Roles that take part in a trust crossing an account line, plus the grants
  // that name an account we know about.
  const crossing = [];
  for (const e of graph.edges) {
    if (e.type !== "TRUSTS") continue;
    const a = acctOf(e.to), b = acctOf(e.from);
    if (!a || !b || a === b) continue;
    crossing.push({ from: e.to, to: e.from, kind: "TRUSTS" });
  }
  // A role whose trust policy names an outside account that is not in the
  // snapshot is still a door; it just leads somewhere we cannot see.
  const external = new Map();
  for (const n of graph.nodes) {
    if (n.label !== "IAMROLE") continue;
    for (const p of (n.properties?.trusted_accounts ?? [])) {
      const acct = String(p);
      if (!acct || acct === n.account_id) continue;
      if (!external.has(acct)) external.set(acct, []);
      external.get(acct).push(n.id);
    }
  }

  const involved = new Set();
  for (const c of crossing) { involved.add(c.from); involved.add(c.to); }

  // Order the accounts so trust flows left to right: the ones that only reach
  // outwards first, the hub everything reaches into last. Otherwise half the
  // lines double back on themselves and the shape is unreadable.
  const flow = new Map(accounts.map((a) => [a, 0]));
  for (const c of crossing) {
    flow.set(acctOf(c.from), (flow.get(acctOf(c.from)) ?? 0) - 1);
    flow.set(acctOf(c.to), (flow.get(acctOf(c.to)) ?? 0) + 1);
  }
  accounts.sort((a, b) => (flow.get(a) ?? 0) - (flow.get(b) ?? 0) || a.localeCompare(b));

  const nodes = [];
  const edges = [];
  const W = A_NODE_W, H = A_NODE_H, GAP = A_GAP, PADX = 18, HEAD = 56;
  let ax = 0;
  for (const acct of accounts) {
    const roles = graph.nodes.filter((n) => n.account_id === acct && involved.has(n.id));
    const inv = graph.nodes.filter((n) => n.account_id === acct).length;
    const rows = Math.max(1, roles.length);
    const boxW = PADX * 2 + W;
    const boxH = HEAD + rows * H + (rows - 1) * GAP + 16;
    nodes.push({
      id: `__acct__${acct}`, type: "group", position: { x: ax, y: 0 },
      style: { width: boxW, height: boxH }, selectable: false, draggable: false, zIndex: 0,
      data: {
        title: `Account ${acct}`,
        subtitle: `${inv} resources   ·   ${roles.length} crossing role(s)`,
        fill: "rgba(99,102,241,0.04)", stroke: roles.length ? "#6366f1" : "#334155",
      },
    });
    roles.forEach((r, i) => {
      nodes.push({
        id: r.id, type: "aws", parentId: `__acct__${acct}`, extent: "parent",
        position: { x: PADX, y: HEAD + i * (H + GAP) },
        style: { width: W, height: H }, width: W, height: H,
        data: {
          name: r.name || String(r.id).split("/").pop(), label: "IAMROLE", resourceLabel: "IAMROLE",
          icon: iconFor("IAMROLE", r.properties), iconKey: iconKey("IAMROLE", r.properties), accentColor: COLORS.IAMROLE ?? "#a78bfa",
          title: `${r.name}\n${r.id}`,
        },
      });
    });
    if (!roles.length) {
      nodes.push({
        id: `__acct__${acct}__none`, type: "aws", parentId: `__acct__${acct}`, extent: "parent",
        position: { x: PADX, y: HEAD },
        style: { width: W, height: H }, width: W, height: H,
        data: { name: "nothing crosses in or out", label: "", resourceLabel: "", accentColor: "#334155" },
      });
    }
    ax += boxW + 120;
  }
  for (const c of crossing) edges.push({ from: c.from, to: c.to, type: "TRUSTS", risk: "medium" });

  // Accounts named in a trust policy that were never scanned.
  let uy = 0;
  for (const [acct, roles] of external) {
    if (accounts.includes(acct)) continue;
    const id = `__ext__${acct}`;
    nodes.push({
      id, type: "aws", position: { x: ax, y: uy },
      style: { width: W, height: H }, width: W, height: H,
      data: { name: acct, label: "UNSCANNED ACCOUNT", resourceLabel: "PUBLIC", accentColor: "#f87171",
        title: `${acct}\nnamed in a trust policy but never scanned` },
    });
    for (const r of roles) edges.push({ from: id, to: r, type: "TRUSTS", risk: "high" });
    uy += H + GAP;
  }
  return { nodes, edges };
}

/* ---------- SVG export ----------
 * Built from the layout data rather than by scraping the canvas: React Flow
 * draws nodes as HTML, so there is no SVG to lift. The AWS icon glyphs *are*
 * inline <svg>, so those are pulled from the DOM by node id and re-embedded,
 * which keeps the export looking like the diagram instead of like boxes.
 */
const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

// Monospace at ~0.6em per char; truncate so text cannot spill past its box.
function fitText(s, px, size) {
  const max = Math.max(1, Math.floor(px / (size * 0.6)));
  const str = String(s ?? "");
  return str.length <= max ? str : str.slice(0, Math.max(1, max - 1)) + "…";
}

// A lifted <svg> without width and height scales to fill whatever contains it,
// which in an export is the whole page. Never trust the source to have set them.
function sizedGlyph(svg) {
  if (!svg) return null;
  return String(svg).replace(/^<svg\b([^>]*)>/i, (m, attrs) => {
    const cleaned = attrs.replace(/\s(width|height)="[^"]*"/gi, "");
    return `<svg${cleaned} width="30" height="30">`;
  });
}

function architectureSvg(nodes, edges, meta) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const absCache = new Map();
  const abs = (n) => {
    if (absCache.has(n.id)) return absCache.get(n.id);
    const p = n.parentId && byId.has(n.parentId) ? abs(byId.get(n.parentId)) : { x: 0, y: 0 };
    const a = { x: p.x + (n.position?.x ?? 0), y: p.y + (n.position?.y ?? 0) };
    absCache.set(n.id, a);
    return a;
  };

  const sized = nodes.map((n) => {
    const a = abs(n);
    const w = n.style?.width ?? A_NODE_W, h = n.style?.height ?? A_NODE_H;
    return { n, x: a.x, y: a.y, w, h };
  });

  // The legend is a block below the diagram rather than an overlay on it: the
  // canvas is sized exactly to its content, so anything floating would cover a
  // resource. A static .svg cannot expand one on click, and colours nobody can
  // decode are worse than no colours.
  const claims = meta.legend === false ? [] : [...new Set((edges ?? []).map((e) => e.kind).filter((k) => CLAIM_STYLE[k]))];
  const risks = meta.legend === false ? [] : [...new Set((edges ?? []).map((e) => e.risk).filter((r) => RISK_STROKE[r]))];
  const legendRows = claims.length + risks.length;
  const legendH = legendRows ? 30 + legendRows * 17 : 0;

  const PAD = 32;
  const maxX = Math.max(...sized.map((s) => s.x + s.w), 0);
  const maxY = Math.max(...sized.map((s) => s.y + s.h), 0);
  const W = maxX + PAD * 2, H = maxY + PAD * 2 + 34 + legendH;

  const parts = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#070b14"/>`);
  parts.push(
    `<text x="${PAD}" y="${PAD - 8}" fill="#e2e8f0" font-family="ui-monospace,monospace" font-size="15" font-weight="700">${esc(meta.title)}</text>`,
  );

  // Parents before children so nesting reads correctly.
  const depth = (n) => (n.parentId && byId.has(n.parentId) ? 1 + depth(byId.get(n.parentId)) : 0);
  const ordered = [...sized].sort((a, b) =>
    (a.n.type === "group" ? 0 : 1) - (b.n.type === "group" ? 0 : 1) || depth(a.n) - depth(b.n));

  for (const s of ordered) {
    const d = s.n.data ?? {};
    const x = s.x + PAD, y = s.y + PAD;
    if (s.n.type === "group") {
      const dash = d.borderStyle === "dashed" ? ' stroke-dasharray="6 4"' : "";
      parts.push(
        `<rect x="${x}" y="${y}" width="${s.w}" height="${s.h}" rx="12" fill="${d.fill ?? "none"}" stroke="${d.stroke ?? "#475569"}" stroke-width="${d.borderWidth ?? 1.5}"${dash}/>`,
      );
      parts.push(`<circle cx="${x + 16}" cy="${y + 18}" r="3" fill="${d.stroke ?? "#475569"}"/>`);
      parts.push(
        `<text x="${x + 26}" y="${y + 22}" fill="#f1f5f9" font-family="ui-monospace,monospace" font-size="11.5" font-weight="600">${esc(fitText(d.title, s.w - 40, 11.5))}</text>`,
      );
      if (d.subtitle) {
        parts.push(
          `<text x="${x + 26}" y="${y + 36}" fill="#94a3b8" font-family="ui-monospace,monospace" font-size="10">${esc(fitText(d.subtitle, s.w - 40, 10))}</text>`,
        );
      }
      continue;
    }

    const accent = d.accentColor ?? "#475569";
    // The whole node goes inside the group: data-node-id lets the HTML export
    // bind a click handler to it, and dimming it has to fade the icon and the
    // text too. With only the rectangle inside, focus faded a border and left
    // everything else at full strength.
    const tx = x + 52, tw = s.w - 64;
    const icon = sizedGlyph(meta.iconFor?.(s.n.id));
    const glyph = icon
      ? `<g transform="translate(${x + 12},${y + 12})">${icon}</g>`
      : `<rect x="${x + 12}" y="${y + 12}" width="30" height="30" rx="5" fill="${accent}"/>` +
        `<text x="${x + 27}" y="${y + 32}" text-anchor="middle" fill="#0b1220" font-family="ui-monospace,monospace" font-size="12" font-weight="700">${esc((d.label ?? "?").slice(0, 2))}</text>`;
    parts.push(
      `<g data-node-id="${esc(s.n.id)}" class="awsome-node">` +
        `<rect x="${x}" y="${y}" width="${s.w}" height="${s.h}" rx="8" fill="#0d1320" stroke="${accent}" stroke-width="${d.emphasised ? 2 : 1}"/>` +
        glyph +
        `<text x="${tx}" y="${y + 25}" fill="#f1f5f9" font-family="ui-monospace,monospace" font-size="11.5">${esc(fitText((d.marker ?? "") + (d.name ?? ""), tw, 11.5))}</text>` +
        `<text x="${tx}" y="${y + 39}" fill="#64748b" font-family="ui-monospace,monospace" font-size="9.5">${esc(fitText(d.label, tw, 9.5))}</text>` +
      `</g>`,
    );
  }

  // Edges carry their endpoints, claim type and risk so the HTML export can
  // highlight them; in a plain .svg the attributes are inert. Styling comes
  // from the same table the canvas uses.
  const edgeAttrs = (e) => {
    const c = CLAIM_STYLE[e.kind] ?? { stroke: "#475569", width: 1.2, dash: "" };
    const risky = Boolean(RISK_STROKE[e.risk]);
    const stroke = risky ? RISK_STROKE[e.risk] : c.stroke;
    return `stroke="${stroke}" stroke-width="${risky ? c.width + 0.4 : c.width}"` +
      (c.dash ? ` stroke-dasharray="${c.dash}"` : "") +
      (c.opacity && !risky ? ` opacity="${c.opacity}"` : "");
  };
  for (const e of edges ?? []) {
    const a = sized.find((s) => s.n.id === e.source), b = sized.find((s) => s.n.id === e.target);
    if (!a || !b) continue;
    parts.push(
      `<line class="awsome-edge" data-from="${esc(e.source)}" data-to="${esc(e.target)}" ` +
        `x1="${a.x + a.w + PAD}" y1="${a.y + a.h / 2 + PAD}" x2="${b.x + PAD}" y2="${b.y + b.h / 2 + PAD}" ${edgeAttrs(e)}/>`,
    );
  }

  if (legendRows) {
    const ly = maxY + PAD + 26;
    parts.push(
      `<text x="${PAD}" y="${ly}" fill="#94a3b8" font-family="ui-monospace,monospace" font-size="10.5" font-weight="700">WHAT THE LINES MEAN</text>`,
    );
    const row = (i, stroke, dash, name, desc) => {
      const y = ly + 18 + i * 17;
      parts.push(
        `<line x1="${PAD}" y1="${y - 4}" x2="${PAD + 30}" y2="${y - 4}" stroke="${stroke}" stroke-width="1.8"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`,
      );
      parts.push(
        `<text x="${PAD + 40}" y="${y}" fill="#e2e8f0" font-family="ui-monospace,monospace" font-size="10">${esc(name)}</text>`,
      );
      parts.push(
        `<text x="${PAD + 140}" y="${y}" fill="#64748b" font-family="ui-monospace,monospace" font-size="10">${esc(desc)}</text>`,
      );
    };
    claims.forEach((k, i) => row(i, CLAIM_STYLE[k].stroke, CLAIM_STYLE[k].dash, k.toLowerCase(), CLAIM_STYLE[k].desc));
    risks.forEach((r, i) =>
      row(claims.length + i, RISK_STROKE[r], "", `${r} risk`, `any line in this colour — ${RISK_DESC[r]}`));
  }

  parts.push(
    `<text x="${PAD}" y="${H - 12}" fill="#475569" font-family="ui-monospace,monospace" font-size="10">${esc(meta.footer)}</text>`,
  );

  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${parts.join("\n")}\n</svg>\n`;
}

/* ---------- Mermaid export ----------
 * Text the diagram can be rebuilt from: renders in GitHub, Confluence and
 * Notion, diffs in git, and can be edited after the fact. It gives up the AWS
 * iconography and the exact layout — Mermaid does its own — so it complements
 * the SVG rather than replacing it.
 */
function architectureMermaid(nodes, edges, meta) {
  const ids = new Map();
  const mid = (id) => {
    if (!ids.has(id)) ids.set(id, `n${ids.size}`);
    return ids.get(id);
  };
  // Mermaid labels are quoted strings; quotes and newlines inside them end the
  // label early, and `#` starts an entity.
  const lbl = (s) => String(s ?? "").replace(/["\n\r]/g, " ").replace(/#/g, "&num;").trim();

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map();
  for (const n of nodes) {
    const p = n.parentId && byId.has(n.parentId) ? n.parentId : "";
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(n);
  }

  const out = [];
  const classes = [];
  const shape = (n) => {
    const name = lbl(n.data?.name ?? String(n.id).split("/").pop());
    const sub = lbl(n.data?.label ?? "");
    const text = sub ? `${name}<br/>${sub}` : name;
    if (String(n.id).startsWith("__")) return `(["${text}"])`;          // an origin, not a resource
    if (STORE_LABELS.includes(n.data?.resourceLabel)) return `[("${text}")]`; // a store
    return `["${text}"]`;
  };

  const emit = (parent, depth) => {
    const pad = "  ".repeat(depth + 1);
    for (const n of children.get(parent) ?? []) {
      if (n.type === "group") {
        const title = lbl(n.data?.title ?? "group");
        const sub = lbl(n.data?.subtitle ?? "");
        out.push(`${pad}subgraph ${mid(n.id)}["${sub ? `${title} — ${sub}` : title}"]`);
        emit(n.id, depth + 1);
        out.push(`${pad}end`);
      } else {
        out.push(`${pad}${mid(n.id)}${shape(n)}`);
        const accent = n.data?.accentColor;
        if (accent) classes.push(`  style ${mid(n.id)} fill:#0d1320,stroke:${accent},color:#e2e8f0`);
      }
    }
  };

  out.push(`%% ${lbl(meta.title)}`);
  if (meta.footer) out.push(`%% ${lbl(meta.footer)}`);
  out.push("flowchart LR");
  emit("", 0);

  const linkStyles = [];
  let li = 0;
  for (const e of edges ?? []) {
    if (!ids.has(e.source) && !byId.has(e.source)) continue;
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    const c = CLAIM_STYLE[e.kind] ?? { stroke: "#475569", width: 1.2, dash: "" };
    const risky = Boolean(RISK_STROKE[e.risk]);
    const stroke = risky ? RISK_STROKE[e.risk] : c.stroke;
    const arrow = c.dash ? "-.->" : "-->";
    const text = e.label ? `|"${lbl(e.label)}"|` : "";
    out.push(`  ${mid(e.source)} ${arrow}${text} ${mid(e.target)}`);
    linkStyles.push(`  linkStyle ${li} stroke:${stroke},stroke-width:${risky ? 2.4 : c.width}px`);
    li++;
  }
  return [...out, ...classes, ...linkStyles].join("\n") + "\n";
}

/* ---------- drift section of the HTML export ----------
 * Pre-rendered rather than built by script, and expanded with <details> rather
 * than a click handler: the browser already knows how to do this, and a report
 * that survives being emailed around should lean on as little of its own code
 * as possible.
 */
function driftHtml(d) {
  if (!d || !d.counts) return "";
  const c = d.counts;
  const short = (k) => String(k ?? "").split("/").pop();

  const stat = (label, n, cls) =>
    `<div class="stat"><div class="n ${cls}">${n ?? 0}</div><div class="l">${esc(label)}</div></div>`;

  const lineRows = (lines) => (lines ?? []).map((l) => {
    const v = (x) => {
      let s = typeof x === "object" && x !== null ? JSON.stringify(x) : String(x ?? "");
      return esc(s.length > 220 ? s.slice(0, 220) + "…" : s);
    };
    if (l.status === "same") return `<div class="ln same"><i> </i><b>${esc(l.path)}</b>${v(l.to)}</div>`;
    if (l.status === "add") return `<div class="ln add"><i>+</i><b>${esc(l.path)}</b>${v(l.to)}</div>`;
    if (l.status === "del") return `<div class="ln del"><i>&minus;</i><b>${esc(l.path)}</b>${v(l.from)}</div>`;
    return `<div class="ln del"><i>&minus;</i><b>${esc(l.path)}</b>${v(l.from)}</div>` +
           `<div class="ln add"><i>+</i><b>${esc(l.path)}</b>${v(l.to)}</div>`;
  }).join("");

  const group = (title, kind, bucket, chip) => {
    if (!bucket?.count) return "";
    const items = (bucket.items ?? []).map((it) => {
      const who = it.attributed_by;
      const attr = who
        ? `<span class="attr">${esc(who.event_name ?? "")} · ${esc(who.user_arn || who.username || who.access_key_id || "unknown")}</span>`
        : "";
      return `<details class="rb ${kind}"><summary><span class="chip">${chip}</span>` +
        `<span class="lbl">${esc(it.label ?? "")}</span>` +
        `<span class="nm">${esc(it.name || short(it.key))}</span>${attr}</summary>` +
        `<div class="lines">${lineRows(it.lines)}</div></details>`;
    }).join("");
    const more = bucket.count > (bucket.items ?? []).length
      ? `<div class="more">… and ${bucket.count - bucket.items.length} more not shown</div>` : "";
    return `<h3 class="dh ${kind}">${esc(title)} <span>${bucket.count}</span></h3>${items}${more}`;
  };

  const edgeRows = (bucket, kind, chip) => (bucket?.items ?? []).map((e) =>
    `<div class="er ${kind}"><span class="chip">${chip}</span>` +
    `<span class="nm">${esc(short(e.from))}</span><span class="ar">→</span>` +
    `<span class="nm">${esc(short(e.to))}</span><span class="ty">${esc(e.type)}</span></div>`).join("");

  const findingRows = (bucket, kind, chip) => (bucket?.items ?? []).map((f) =>
    `<div class="er ${kind}"><span class="chip">${chip}</span>` +
    `<span class="pill ${esc(f.severity)}">${esc(f.severity)}</span>` +
    `<span class="nm">${esc(f.rule)}</span>` +
    `<span class="ty">${esc(f.resource_name || short(f.resource_key))}</span></div>`).join("");

  const stamp = (m) => m ? `${esc(m.id)}${m.finished_at ? ` · ${esc(m.finished_at)}` : ""}${m.user ? ` · ${esc(m.user)}` : ""}` : "";
  const trail = d.trail?.attributed
    ? `<span class="tr">${d.trail.attributed} change(s) attributed via CloudTrail</span>`
    : `<span class="tr muted">trail: ${d.trail?.available_from ? d.trail.events_from + " ev" : "unavailable"} → ${d.trail?.available_to ? d.trail.events_to + " ev" : "unavailable"}</span>`;

  return `<div class="dwrap">
  <div class="dmeta"><span>${stamp(d.meta?.from)}</span><span class="ar">→</span><span>${stamp(d.meta?.to)}</span>${trail}</div>
  <div class="stats">
    ${stat("added", c.nodes_added, "add")}${stat("removed", c.nodes_removed, "del")}${stat("changed", c.nodes_changed, "chg")}
    ${stat("edges +", c.edges_added, "add")}${stat("edges −", c.edges_removed, "del")}
    ${stat("findings +", c.findings_added, "add")}${stat("findings −", c.findings_removed, "del")}${stat("findings ~", c.findings_changed, "chg")}
  </div>
  ${group("Added resources", "add", d.nodes_added, "+")}
  ${group("Removed resources", "del", d.nodes_removed, "&minus;")}
  ${group("Changed resources", "chg", d.nodes_changed, "~")}
  ${(c.edges_added || c.edges_removed) ? `<h3 class="dh">Edges <span class="add">+${c.edges_added}</span> <span class="del">&minus;${c.edges_removed}</span></h3>
    ${edgeRows(d.edges_added, "add", "+")}${edgeRows(d.edges_removed, "del", "&minus;")}` : ""}
  ${(c.findings_added || c.findings_removed) ? `<h3 class="dh">Findings <span class="add">+${c.findings_added}</span> <span class="del">&minus;${c.findings_removed}</span></h3>
    ${findingRows(d.findings_added, "add", "+")}${findingRows(d.findings_removed, "del", "&minus;")}` : ""}
</div>`;
}

/* ---------- self-contained HTML export ----------
 * One file: the architecture SVG, click-to-inspect, findings, and the drift
 * between two snapshots. No server, no network, no build step — the diagram is
 * inlined as SVG and the data as JSON, so it opens offline and survives being
 * emailed around.
 */
function architectureHtml(nodes, edges, findings, meta) {
  // One view, or all of them. Either way the panes are built the same way, so
  // the single-diagram report and the full one share every line below.
  const panes = meta.views?.length
    ? meta.views
    : [{ id: "only", label: "diagram", hint: "", nodes, edges, iconFor: meta.iconFor }];
  const svgOf = (v) => architectureSvg(v.nodes, v.edges, { ...meta, iconFor: v.iconFor ?? meta.iconFor, legend: false })
    .replace(/^<\?xml[^>]*\?>\s*/, ""); // inline SVG must not carry an XML prolog
  const drift = driftHtml(meta.drift);

  // Only the resources drawn on the diagram, with the fields the panel shows.
  // Origins — the internet, an address range — are drawn and can be focused on,
  // but they back no resource, so they get no panel rather than an empty one.
  const detail = {};
  for (const v of panes) {
    for (const n of v.nodes) {
      if (n.type === "group" || String(n.id).startsWith("__")) continue;
      const src = meta.nodeById?.(n.id);
      if (!src) continue; // lane-local duplicates resolve to the same resource
      detail[n.id] = {
        name: n.data?.name ?? "",
        label: n.data?.label ?? "",
        properties: src.properties ?? {},
      };
    }
  }
  const active = (findings ?? []).filter((f) => !f.suppressed);
  const counts = {};
  for (const f of active) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

  // Script content is raw text, not entity-decoded, so HTML-escaping would
  // corrupt the JSON. Escaping "<" as \u003c is valid JSON and cannot terminate
  // the tag.
  const links = {};
  for (const v of panes) {
    links[v.id] = (v.edges ?? []).filter((e) => e.source && e.target)
      .map((e) => ({ f: e.source, t: e.target, k: e.kind ?? "", r: e.risk ?? "" }));
  }
  const payload = JSON.stringify({ detail, findings: active, links }).replace(/</g, "\\u003c");

  const sevRow = ["critical", "high", "medium", "low"]
    .filter((k) => counts[k])
    .map((k) => `<span class="pill ${k}">${counts[k]} ${k}</span>`)
    .join("");

  // Built from the same table the canvas styles edges with, and listing only
  // the claims this diagram actually contains — a legend for lines that are not
  // on the page teaches the reader nothing.
  const swatch = (stroke, dash, w) =>
    `<svg width="30" height="8" aria-hidden="true"><line x1="0" y1="4" x2="30" y2="4" stroke="${stroke}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ""}/></svg>`;
  // One legend covering every claim on any pane: switching view should not move
  // the reader's reference out from under them.
  const allEdges = panes.flatMap((v) => v.edges ?? []);
  const claimRows = [...new Set(allEdges.map((e) => e.kind))].filter((k) => CLAIM_STYLE[k])
    .map((k) => `<div class="lg">${swatch(CLAIM_STYLE[k].stroke, CLAIM_STYLE[k].dash, 1.8)}<b>${esc(k.toLowerCase())}</b><span>${esc(CLAIM_STYLE[k].desc)}</span></div>`)
    .join("");
  const riskRows = [...new Set(allEdges.map((e) => e.risk))].filter((r) => RISK_STROKE[r])
    .map((r) => `<div class="lg">${swatch(RISK_STROKE[r], "", 2.4)}<b>${esc(r)}</b><span>${esc(RISK_DESC[r])}</span></div>`)
    .join("");
  const viewTabs = panes.length > 1
    ? `<div class="views">${panes.map((v, i) =>
        `<button class="vt" data-view="${esc(v.id)}" aria-selected="${i === 0}" title="${esc(v.hint ?? "")}">${esc(v.label)}</button>`).join("")}</div>`
    : "";
  const viewPanes = panes.map((v, i) =>
    `<div class="pane" id="pane-${esc(v.id)}" data-view="${esc(v.id)}"${i ? ' style="display:none"' : ""}>${svgOf(v)}</div>`).join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${esc(meta.title)}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#070b14;color:#e2e8f0;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
header{display:flex;align-items:center;gap:14px;padding:12px 18px;border-bottom:1px solid #1e2a45;flex-wrap:wrap}
h1{font-size:15px;margin:0;font-weight:700}
.sub{color:#64748b;font-size:11.5px}
.tabs{display:flex;gap:6px;margin-left:auto}
button.tab{background:#0d1320;color:#94a3b8;border:1px solid #2a3550;border-radius:8px;padding:5px 12px;cursor:pointer;font:inherit;font-size:12px}
button.tab[aria-selected=true]{background:#1e293b;color:#f1f5f9;border-color:#475569}
.pill{display:inline-block;border-radius:999px;padding:1px 9px;font-size:11px;margin-right:6px;border:1px solid}
.critical{color:#fca5a5;border-color:#7f1d1d;background:#7f1d1d33}
.high{color:#fdba74;border-color:#7c2d12;background:#7c2d1233}
.medium{color:#fde68a;border-color:#78350f;background:#78350f33}
.low{color:#a7f3d0;border-color:#064e3b;background:#064e3b33}
main{position:relative;height:calc(100vh - 58px);overflow:auto}
#diagram{padding:16px}
#diagram svg{max-width:none}
.awsome-node{cursor:pointer}
#diagram svg text{pointer-events:none}
.awsome-node,.awsome-edge{transition:opacity .12s}
.dim{opacity:.16}
.dim-edge{opacity:.07}
.awsome-node:hover rect{stroke-width:2.5}
#panel{position:fixed;right:14px;top:70px;width:380px;max-height:calc(100vh - 92px);overflow:auto;background:#0a0f1cf2;border:1px solid #2a3550;border-radius:12px;padding:14px;display:none;backdrop-filter:blur(4px)}
#panel.open{display:block}
#panel h2{margin:0 0 2px;font-size:13px}
#panel .lbl{color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.08em}
table{width:100%;border-collapse:collapse;font-size:11.5px}
td{padding:3px 0;border-bottom:1px solid #ffffff0d;vertical-align:top;word-break:break-word}
td.k{color:#64748b;width:44%;padding-right:8px}
#findings{display:none;padding:16px 18px}
.f{border:1px solid #1e2a45;border-radius:10px;padding:10px 12px;margin-bottom:8px;background:#0d132080}
.f .msg{font-size:12.5px;margin-top:4px}
.f .rem{font-size:11.5px;color:#94a3b8;margin-top:4px}
.f .res{font-size:11px;color:#64748b;margin-top:4px;word-break:break-all}
.close{float:right;color:#64748b;cursor:pointer;border:0;background:none;font:inherit}
#legend{position:fixed;right:14px;bottom:14px;z-index:30;display:flex;flex-direction:column;align-items:flex-end;gap:6px}
#lg-toggle{width:26px;height:26px;border-radius:999px;border:1px solid #2a3550;background:#0d1320f2;color:#94a3b8;cursor:pointer;font:italic 600 13px/1 ui-monospace,monospace}
#lg-toggle:hover,#legend:not(.collapsed) #lg-toggle{color:#f1f5f9;border-color:#475569}
#lg-body{width:395px;max-height:44vh;overflow:auto;background:#0a0f1cf2;border:1px solid #2a3550;border-radius:10px;padding:10px 12px;backdrop-filter:blur(4px)}
#legend.collapsed #lg-body{display:none}
.lg-h{color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.08em;margin:6px 0 4px}
.lg-h:first-child{margin-top:0}
.lg{display:grid;grid-template-columns:34px 76px 1fr;align-items:baseline;gap:6px;font-size:11px;padding:2px 0}
.lg b{color:#e2e8f0;font-weight:600}
.lg span{color:#64748b;line-height:1.35}
.views{position:sticky;left:0;display:flex;flex-wrap:wrap;gap:6px;padding:0 0 12px}
button.vt{background:#0d1320;color:#94a3b8;border:1px solid #2a3550;border-radius:8px;padding:4px 11px;cursor:pointer;font:inherit;font-size:11.5px}
button.vt[aria-selected=true]{background:#1e293b;color:#f1f5f9;border-color:#475569}
.pane svg{max-width:none}
#drift{display:none;padding:16px 18px;max-width:1100px}
.dmeta{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:11.5px;color:#94a3b8;margin-bottom:12px}
.dmeta .ar{color:#475569}
.dmeta .tr{margin-left:auto;border:1px solid #78350f;background:#78350f33;color:#fde68a;border-radius:999px;padding:1px 9px;font-size:11px}
.dmeta .tr.muted{border-color:#1e2a45;background:none;color:#475569}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:6px}
@media(min-width:900px){.stats{grid-template-columns:repeat(8,1fr)}}
.stat{border:1px solid #1e2a45;border-radius:10px;padding:8px 10px;background:#0d132080}
.stat .n{font-size:17px;font-weight:700}
.stat .l{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.06em}
.add{color:#4ade80}.del{color:#f87171}.chg{color:#fbbf24}
h3.dh{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8;margin:18px 0 6px;font-weight:600}
h3.dh span{font-family:inherit}
.rb{border:1px solid #1e2a45;border-radius:10px;margin-bottom:5px;background:#0d132080}
.rb summary{display:flex;align-items:center;gap:9px;padding:7px 12px;cursor:pointer;list-style:none;font-size:12.5px}
.rb summary::-webkit-details-marker{display:none}
.rb[open]{border-color:#334155}
.rb .chip{font-weight:700;width:9px}
.rb.add .chip{color:#4ade80}.rb.del .chip{color:#f87171}.rb.chg .chip{color:#fbbf24}
.lbl{font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:#64748b;min-width:92px}
.nm{color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.attr{margin-left:auto;border:1px solid #78350f;background:#78350f33;color:#fde68a;border-radius:999px;padding:0 8px;font-size:10.5px;white-space:nowrap}
.lines{border-top:1px solid #1e2a45;max-height:380px;overflow:auto;padding:3px 0}
.ln{display:flex;gap:8px;padding:0 12px;font-size:12px;line-height:1.6}
.ln i{width:10px;font-style:normal;font-weight:700;text-align:center}
.ln b{min-width:140px;font-weight:400}
.ln.add{background:#10b98119}.ln.add i{color:#4ade80}.ln.add b{color:#a7f3d0cc}
.ln.del{background:#ef444419}.ln.del i{color:#f87171}.ln.del b{color:#fecacacc}
.ln.same{color:#475569}.ln.same b{color:#64748b}
.er{display:flex;align-items:center;gap:9px;padding:3px 12px;font-size:11.5px;border-bottom:1px solid #ffffff0a}
.er .chip{font-weight:700;width:9px}
.er.add .chip{color:#4ade80}.er.del .chip{color:#f87171}
.er .ar,.er .ty{color:#475569}
.er .ty{margin-left:auto;font-size:10.5px}
.more{font-size:11px;color:#475569;padding:3px 2px}
.dnone{border:1px solid #1e2a45;border-radius:10px;padding:14px;color:#64748b;font-size:12.5px}
</style></head><body>
<header>
  <div><h1>${esc(meta.title)}</h1><div class="sub">${esc(meta.footer)}</div></div>
  <div>${sevRow}</div>
  <div class="tabs">
    <button class="tab" id="t-diagram" aria-selected="true">diagram</button>
    <button class="tab" id="t-findings" aria-selected="false">findings</button>
    <button class="tab" id="t-drift" aria-selected="false">drift</button>
  </div>
</header>
<main>
  <div id="diagram">${viewTabs}${viewPanes}</div>
  <div id="findings"></div>
  <div id="drift">${drift || '<div class="dnone">No snapshot comparison was available when this report was exported.</div>'}</div>
  <aside id="panel"><button class="close" id="x">&times;</button>
    <div class="lbl" id="p-label"></div><h2 id="p-name"></h2>
    <div id="p-findings"></div>
    <div class="lbl" style="margin-top:10px">properties</div>
    <table id="p-props"></table>
    <div class="lbl" style="margin-top:10px">arn</div>
    <div class="res" id="p-arn"></div>
  </aside>
  ${claimRows ? `<div id="legend" class="collapsed">
    <div id="lg-body">
      <div class="lg-h">what the lines mean</div>
      ${claimRows}
      ${riskRows ? `<div class="lg-h">colour by risk</div>${riskRows}` : ""}
    </div>
    <button id="lg-toggle" title="What the lines mean" aria-expanded="false">i</button>
  </div>` : ""}
</main>
<script id="data" type="application/json">${payload}</script>
<script>
(function(){
  var D = JSON.parse(document.getElementById("data").textContent);
  var panel = document.getElementById("panel");
  var esc = function(s){ var d=document.createElement("div"); d.textContent = s==null?"":String(s); return d.innerHTML; };
  var fmt = function(v){
    if (v===null||v===undefined||v==="") return "&mdash;";
    if (Array.isArray(v)) return v.length?esc(v.join(", ")):"&mdash;";
    if (typeof v==="object") return esc(JSON.stringify(v));
    return esc(v);
  };
  function show(id){
    var n = D.detail[id]; if(!n) return;
    document.getElementById("p-label").textContent = n.label;
    document.getElementById("p-name").textContent = n.name || id.split("/").pop();
    document.getElementById("p-arn").textContent = id;
    var mine = D.findings.filter(function(f){return f.resource_key===id;});
    document.getElementById("p-findings").innerHTML = mine.length
      ? '<div class="lbl" style="margin-top:8px">findings</div>' + mine.map(function(f){
          return '<div class="f"><span class="pill '+esc(f.severity)+'">'+esc(f.severity)+'</span> '+esc(f.rule)+
                 '<div class="msg">'+esc(f.message)+'</div></div>';
        }).join("")
      : "";
    var keys = Object.keys(n.properties||{}).sort();
    document.getElementById("p-props").innerHTML = keys.length
      ? keys.map(function(k){return '<tr><td class="k">'+esc(k)+'</td><td>'+fmt(n.properties[k])+'</td></tr>';}).join("")
      : '<tr><td colspan="2">no properties collected</td></tr>';
    panel.classList.add("open");
  }
  // ---- focus: same reduction as the app ----------------------------------
  // Resources nothing connects to recede from the start; selecting one leaves
  // only its connections lit. Skipped when there are no edges at all, as in the
  // component view, where dimming by connectivity would fade everything.
  // Each view is its own pane with its own links; focus applies within the pane
  // on screen, because a resource can appear on several of them.
  var panes = {};
  [].slice.call(document.querySelectorAll(".pane")).forEach(function(el){
    var v = el.getAttribute("data-view");
    var links = (D.links && D.links[v]) || [];
    var touching = {};
    links.forEach(function(l){ touching[l.f] = true; touching[l.t] = true; });
    panes[v] = {
      el: el,
      links: links,
      touching: touching,
      nodes: [].slice.call(el.querySelectorAll(".awsome-node")),
      edges: [].slice.call(el.querySelectorAll(".awsome-edge")),
    };
  });
  var activeView = Object.keys(panes)[0];

  function applyFocus(id){
    var p = panes[activeView];
    if (!p || !p.links.length) return;
    var keep = null;
    if (id) {
      keep = {}; keep[id] = true;
      p.links.forEach(function(l){
        if (l.f === id) keep[l.t] = true;
        if (l.t === id) keep[l.f] = true;
      });
    }
    p.nodes.forEach(function(g){
      var nid = g.getAttribute("data-node-id");
      var lit = keep ? !!keep[nid] : !!p.touching[nid];
      g.classList.toggle("dim", !lit);
    });
    p.edges.forEach(function(ln){
      var on = keep ? (keep[ln.getAttribute("data-from")] && keep[ln.getAttribute("data-to")]) : true;
      ln.classList.toggle("dim-edge", !on);
    });
  }

  Object.keys(panes).forEach(function(v){
    panes[v].nodes.forEach(function(g){
      g.addEventListener("click", function(e){
        e.stopPropagation();
        var id = g.getAttribute("data-node-id");
        show(id);
        applyFocus(id);
      });
    });
  });
  applyFocus(null);

  var vts = [].slice.call(document.querySelectorAll(".vt"));
  vts.forEach(function(btn){
    btn.addEventListener("click", function(){
      activeView = btn.getAttribute("data-view");
      vts.forEach(function(b2){ b2.setAttribute("aria-selected", b2 === btn); });
      Object.keys(panes).forEach(function(v){ panes[v].el.style.display = v === activeView ? "block" : "none"; });
      panel.classList.remove("open");
      applyFocus(null);
    });
  });
  function reset(){ panel.classList.remove("open"); applyFocus(null); }
  // A resource that is on no pane (an origin, a lane-local duplicate) simply
  // has no panel; clicking it still refocuses.
  // clicking empty canvas closes and restores, matching the app
  document.getElementById("diagram").addEventListener("click", reset);
  document.getElementById("x").addEventListener("click", reset);

  var legend = document.getElementById("legend");
  if (legend) {
    var lgToggle = document.getElementById("lg-toggle");
    lgToggle.addEventListener("click", function(e){
      e.stopPropagation();
      var open = legend.classList.toggle("collapsed") === false;
      lgToggle.setAttribute("aria-expanded", String(open));
    });
    // the legend is not canvas; clicking inside it must not reset the focus
    legend.addEventListener("click", function(e){ e.stopPropagation(); });
  }

  var order = {critical:0, high:1, medium:2, low:3, info:4};
  var list = D.findings.slice().sort(function(a,b){
    return (order[a.severity]-order[b.severity]) || a.rule.localeCompare(b.rule);
  });
  document.getElementById("findings").innerHTML = list.length ? list.map(function(f){
    return '<div class="f"><span class="pill '+esc(f.severity)+'">'+esc(f.severity)+'</span> <b>'+esc(f.rule)+'</b>'+
      '<div class="msg">'+esc(f.message)+'</div>'+
      (f.remediation?'<div class="rem">&rarr; '+esc(f.remediation)+'</div>':'')+
      '<div class="res">'+esc(f.resource_name||"")+' '+esc(f.resource_key)+'</div></div>';
  }).join("") : '<div class="f">No active findings.</div>';

  var TABS = ["diagram", "findings", "drift"];
  function tab(which){
    TABS.forEach(function(t){
      document.getElementById(t).style.display = t===which?"block":"none";
      document.getElementById("t-"+t).setAttribute("aria-selected", t===which);
    });
    // the legend describes the diagram's lines, so it goes away with them
    if (legend) legend.style.display = which==="diagram"?"flex":"none";
    if (which!=="diagram") reset();
  }
  TABS.forEach(function(t){
    document.getElementById("t-"+t).addEventListener("click", function(){tab(t);});
  });
})();
</script></body></html>
`;
}

/* ---------- resource detail panel ----------
 * Opens on clicking a resource, closes on clicking empty canvas. Containers
 * (VPC, AZ, subnet, service groups) are not selectable, so only actual
 * resources can open it.
 */
function DetailPanel({ node, findings, onClose }) {
  if (!node) return null;
  const props = node.properties ?? {};
  const keys = Object.keys(props).sort();
  const mine = (findings ?? []).filter((f) => f.resource_key === node.id);

  const fmt = (v) => {
    if (v === null || v === undefined || v === "") return "—";
    if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  };

  return h("div", {
    className: "absolute right-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[380px] flex-col rounded-xl border border-white/10 bg-ink-900/95 shadow-2xl backdrop-blur",
    // clicks inside must not reach the canvas and close the panel
    onClick: (e) => e.stopPropagation(),
  },
    h("div", { className: "flex shrink-0 items-start gap-2.5 border-b border-white/10 px-4 py-3" },
      node.icon ? h(node.icon, { width: 26, height: 26, style: { flexShrink: 0 } }) : null,
      h("div", { className: "min-w-0 flex-1" },
        h("div", { className: "truncate font-mono text-[13px] font-semibold text-slate-100" }, node.name || "—"),
        h("div", { className: "font-mono text-[10px] uppercase tracking-wide text-slate-500" }, node.label),
      ),
      h("button", {
        className: "shrink-0 rounded px-1.5 text-slate-500 hover:text-slate-200",
        onClick: onClose, title: "close",
      }, "✕"),
    ),
    h("div", { className: "min-h-0 flex-1 overflow-y-auto px-4 py-3" },
      mine.length
        ? h("div", { className: "mb-3" },
            h("div", { className: "kpi-label pb-1.5" }, `findings (${mine.length})`),
            mine.map((f, i) =>
              h("div", { key: i, className: "mb-1.5 rounded-lg border border-white/10 bg-white/[0.02] p-2" },
                h("div", { className: "flex items-center gap-1.5" },
                  h("span", { className: cx("sevbadge", (SEV[f.severity] ?? SEV.info).badge) }, f.severity),
                  h("span", { className: "truncate font-mono text-[10.5px] text-slate-400" }, f.rule),
                  f.suppressed ? h("span", { className: "chip" }, "accepted") : null,
                ),
                h("div", { className: "pt-1 text-[11.5px] leading-snug text-slate-300" }, f.message),
              )
            ),
          )
        : null,
      h("div", { className: "kpi-label pb-1.5" }, "properties"),
      keys.length
        ? h("dl", { className: "space-y-1" },
            keys.map((k) =>
              h("div", { key: k, className: "flex gap-2 border-b border-white/5 py-1 last:border-0" },
                h("dt", { className: "w-[44%] shrink-0 font-mono text-[10.5px] text-slate-500" }, k),
                h("dd", { className: "min-w-0 flex-1 break-words font-mono text-[10.5px] text-slate-200" }, fmt(props[k])),
              )
            ),
          )
        : h("div", { className: "text-[11.5px] text-slate-500" }, "no properties collected"),
      h("div", { className: "kpi-label pb-1.5 pt-3" }, "arn"),
      h("div", { className: "break-all font-mono text-[10px] text-slate-400" }, node.id),
    ),
  );
}

/* ---------- edge legend ----------
 * Bottom right, above the minimap, collapsed by default: a diagram whose legend
 * has to stay open is one whose lines do not read on their own. It lists only
 * the claims this diagram actually contains, so it shrinks as the view narrows.
 */
function Legend({ view, edges }) {
  const [open, setOpen] = useState(false);

  const groups = useMemo(() => {
    // Every derived view styles its edges from the same table, so the legend
    // reads the diagram rather than the view name: whatever claims are on
    // screen are the ones explained.
    const rows = DERIVED_VIEWS.has(view)
      ? [
          ...[...new Set(edges.map((e) => e.kind))].filter((k) => CLAIM_STYLE[k]).map((k) => ({
            group: "what the lines mean", name: k.toLowerCase(), width: 1.8,
            stroke: CLAIM_STYLE[k].stroke, dash: CLAIM_STYLE[k].dash, desc: CLAIM_STYLE[k].desc,
          })),
          ...[...new Set(edges.map((e) => e.risk))].filter((r) => RISK_STROKE[r]).map((r) => ({
            group: "colour by risk", name: r, width: 2.4,
            stroke: RISK_STROKE[r], dash: "", desc: RISK_DESC[r],
          })),
        ]
      : [
          { group: "what the lines mean", name: "references", stroke: "#f97316", dash: "5 5", width: 1.8,
            desc: "a security group names another as a source" },
          { group: "what the lines mean", name: "other", stroke: "#475569", dash: "", width: 1.8,
            desc: "collected relationships — attachment, membership, routing" },
        ];
    const out = [];
    for (const r of rows) {
      const g = out.find((x) => x.title === r.group);
      if (g) g.rows.push(r);
      else out.push({ title: r.group, rows: [r] });
    }
    return out;
  }, [view, edges]);

  if (!groups.length) return null;

  return h("div", { className: "absolute bottom-[178px] right-4 z-20 flex flex-col items-end gap-1.5" },
    open
      ? h("div", {
          className: "max-h-[44vh] w-[26rem] overflow-auto rounded-xl border border-white/10 bg-[#0a0f1c]/95 p-3 backdrop-blur",
        },
          groups.map((g, gi) =>
            h("div", { key: g.title },
              h("div", { className: cx("text-[10px] uppercase tracking-[0.08em] text-slate-500", gi ? "mt-2.5" : "") }, g.title),
              g.rows.map((r) =>
                h("div", { key: r.name, className: "mt-1 grid grid-cols-[34px_76px_1fr] items-baseline gap-1.5 text-[11px]" },
                  h("svg", { width: 30, height: 8, className: "self-center" },
                    h("line", { x1: 0, y1: 4, x2: 30, y2: 4, stroke: r.stroke, strokeWidth: r.width, strokeDasharray: r.dash || undefined })),
                  h("b", { className: "font-semibold text-slate-200" }, r.name),
                  h("span", { className: "leading-snug text-slate-500" }, r.desc))),
            )),
        )
      : null,
    h("button", {
      className: "flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-[#0d1320]/95 text-slate-400 hover:border-slate-600 hover:text-slate-100",
      onClick: () => setOpen((v) => !v),
      title: "What the lines mean",
      "aria-expanded": open,
    }, h(Icon, { name: "info", className: "h-4 w-4" })),
  );
}

function FlowCanvas({ nodes, edges, overlayByKey, COLORS, viewKey, onNodeClick, onPaneClick, detail, canExport, exportTitle, exportAllTitle, exportFooter, findings, nodeById, ensureDrift, exportRef, iconKeys, buildAllViews }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!nodes.length) return;
    let stopped = false, tries = 0;
    const attempt = () => {
      if (stopped) return;
      tries++;
      fitView({ padding: 0.12, maxZoom: 1.2 }).then((done) => {
        if (!done && tries < 20) setTimeout(attempt, 150);
      });
    };
    const id = requestAnimationFrame(attempt);
    return () => { stopped = true; cancelAnimationFrame(id); };
  }, [nodes.length, edges.length, viewKey]);
  // Glyph lookup for the exports: keyed by the icon, not by the node, so a view
  // that was never rendered still gets its iconography.
  const glyphResolver = (list) => {
    const byKey = new Map();
    for (const el of document.querySelectorAll("[data-icon-key]")) {
      const g = el.querySelector("svg");
      if (g) byKey.set(el.getAttribute("data-icon-key"), g.outerHTML);
    }
    const keyOf = new Map(list.map((n) => [n.id, n.data?.iconKey ?? n.data?.resourceLabel ?? ""]));
    return (id) => byKey.get(keyOf.get(id)) ?? null;
  };

  const exportSvg = () => {
    const svg = architectureSvg(nodes, edges, {
      title: exportTitle ?? "AWS architecture",
      footer: exportFooter ?? "",
      iconFor: glyphResolver(nodes),
    });
    download(svg, "image/svg+xml", "svg");
  };

  const exportHtml = async () => {
    // The report carries all three views, so it fetches the snapshot comparison
    // if the drift overlay was never switched on — "export" should not quietly
    // mean "export whatever happens to be loaded".
    let drift = null;
    try { drift = await ensureDrift?.(); } catch { /* a report without drift beats no report */ }

    const html = architectureHtml(nodes, edges, findings ?? [], {
      title: exportTitle ?? "AWS architecture",
      footer: exportFooter ?? "",
      iconFor: glyphResolver(nodes),
      nodeById,
      drift,
    });
    download(html, "text/html", "html");
  };

  // "Export all": every laid-out view in one offline file. The builders are
  // pure functions of the graph, so the views that are not on screen can be
  // laid out here rather than by switching to each one in turn.
  const exportAll = async () => {
    let drift = null;
    try { drift = await ensureDrift?.(); } catch { /* a report without drift beats no report */ }
    const views = (buildAllViews?.() ?? []).map((v) => ({
      ...v, iconFor: glyphResolver(v.nodes),
    }));
    if (!views.length) return;
    const html = architectureHtml(views[0].nodes, views[0].edges, findings ?? [], {
      title: exportAllTitle ?? "AWS architecture",
      footer: exportFooter ?? "",
      iconFor: views[0].iconFor,
      nodeById,
      drift,
      views,
    });
    download(html, "text/html", "html");
  };

  function download(body, mime, ext) {
    const url = URL.createObjectURL(new Blob([body], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(exportTitle ?? "architecture").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const exportMermaid = () => {
    download(architectureMermaid(nodes, edges, {
      title: exportTitle ?? "AWS architecture",
      footer: exportFooter ?? "",
    }), "text/vnd.mermaid", "mmd");
  };

  // The export controls live in the toolbar with the other view controls, not
  // floating over the diagram where they covered it and were easy to miss. The
  // handlers have to stay here, where the laid-out nodes and the rendered icon
  // glyphs are, so they are published upward rather than lifted.
  useEffect(() => {
    if (!exportRef) return;
    exportRef.current = canExport
      ? { svg: exportSvg, html: exportHtml, mmd: exportMermaid, all: exportAll }
      : null;
    return () => { exportRef.current = null; };
  });

  return h("div", { className: "relative h-full w-full" },
    detail,
    // Every glyph the estate can show, rendered once and hidden. The SVG export
    // lifts glyphs out of the DOM, and "export all" covers views that are not
    // on screen — without this it could only draw the view you were looking at.
    h("div", { className: "pointer-events-none absolute -z-10 h-0 w-0 overflow-hidden opacity-0", "aria-hidden": "true" },
      (iconKeys ?? []).map((k) => {
        const [label, variant] = k.split(":");
        const El = iconFor(label, { map_public_ip: variant === "public" });
        // Sized by attribute, exactly as AwsNode does: the export lifts this
        // markup verbatim, and an <svg> with no width fills whatever contains it.
        return El ? h("span", { key: k, "data-icon-key": k }, h(El, { width: 30, height: 30 })) : null;
      })),
    canExport ? h(Legend, { view: viewKey, edges }) : null,
    h(ReactFlow, {
      nodes, edges, nodesDraggable: false,
      edgesUpdatable: false, nodeTypes: NODE_TYPES, defaultEdgeOptions: { type: "default" },
      onNodeClick, onPaneClick,
    },
      h(Background, { color: "#16213a" }),
      h(Controls, { style: { background: "#0d1320", color: "#9ca3af", borderColor: "#2a3550" } }),
      h(MiniMap, {
        nodeColor: (n) => {
          const ov = overlayByKey.get(n.id);
          if (ov === "add") return "#4ade80";
          if (ov === "mod") return "#fbbf24";
          return n.data?.resourceLabel === "Finding" ? "#f97316" : COLORS[n.data?.resourceLabel] ?? "#475569";
        },
        maskColor: "rgba(255,255,255,0.05)",
        style: { background: "#0a0f1c", border: "1px solid #1e2a45" },
      })
    )
  );
}

/* ============================================================ */
/*  SUMMARY  (security posture)                                   */
/* ============================================================ */
function Ring({ score }) {
  const R = 44, C = 2 * Math.PI * R;
  const col = ringColor(score);
  const pct = score / 100;
  return h("div", { className: "relative h-28 w-28 shrink-0" },
    h("svg", { viewBox: "0 0 100 100", className: "h-full w-full -rotate-90" },
      h("circle", { cx: 50, cy: 50, r: R, fill: "none", stroke: "rgba(148,163,184,0.14)", strokeWidth: 10 }),
      h("circle", {
        cx: 50, cy: 50, r: R, fill: "none", stroke: col, strokeWidth: 10, strokeLinecap: "round",
        strokeDasharray: `${C * pct} ${C}`,
        style: { transition: "stroke-dasharray 0.6s ease, stroke 0.3s ease" },
      }),
    ),
    h("div", { className: "absolute inset-0 flex flex-col items-center justify-center" },
      h("div", { className: "font-mono text-3xl font-bold", style: { color: col } }, score),
      h("div", { className: "text-[10px] font-semibold uppercase tracking-widest text-slate-500" }, "posture"),
    ),
  );
}

function Summary({ summary, findingsData, jobs, go }) {
  if (!summary) {
    return h("div", { className: "flex h-full items-center justify-center" },
      h("div", { className: "h-6 w-6 animate-spin rounded-full border-2 border-white/10 border-t-sky-400" }));
  }
  const latest = summary.latest_snapshot;
  const fcounts = summary.findings?.bySeverity ?? {};
  const ftotal = Object.values(fcounts).reduce((a, b) => a + b, 0) || summary.findings?.total || 0;
  const p = posture(summary.findings);
  const list = findingsData?.findings ?? [];
  const labels = summary.labels ?? {};
  const mix = Object.entries(labels).sort((a, b) => b[1] - a[1]);
  const topMix = mix.slice(0, 7);
  const mixTotal = mix.reduce((a, [, v]) => a + v, 0);
  const topFindings = [...list].sort((a, b) =>
    (SEV_ORDER.indexOf(a.severity) || 9) - (SEV_ORDER.indexOf(b.severity) || 9) || a.rule.localeCompare(b.rule)
  ).slice(0, 5);
  const recent = (jobs ?? []).filter((j) => j.status === "completed").slice(0, 4);

  if (!latest) {
    return h("div", { className: "flex h-full items-center justify-center p-8" },
      h("div", { className: "card max-w-lg p-8 text-center fade-in" },
        h("div", { className: "mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/15 text-indigo-300" }, h(Icon, { name: "scan", className: "h-7 w-7" })),
        h("h2", { className: "text-lg font-semibold text-slate-100" }, "No data yet"),
        h("p", { className: "mt-2 text-sm text-slate-400" }, "AWSome has not scanned an account yet. Run your first scan to map resources into Neo4j, surface findings, and track drift."),
        h("div", { className: "mt-6 flex items-center justify-center gap-3" },
          h("button", { className: "btn-primary", onClick: () => go("scans") }, h(Icon, { name: "play" }), "Open scans"),
        ),
      ),
    );
  }

  const maxSev = fcounts.critical ? "critical" : fcounts.high ? "high" : fcounts.medium ? "medium" : fcounts.low ? "low" : "info";
  const sevRows = SEV_ORDER.filter((s) => fcounts[s] > 0);

  return h("div", { className: "mx-auto max-w-6xl min-h-0 flex-1 overflow-y-auto px-6 py-6 fade-in" },
    h("div", { className: "grid gap-4 lg:grid-cols-[340px_1fr]" },
      /* posture hero */
      h("div", { className: "card flex items-center gap-5 p-5" },
        h(Ring, { score: p.score }),
        h("div", { className: "min-w-0" },
          h("div", { className: "flex items-center gap-2" },
            h("span", { className: "font-mono text-2xl font-bold", style: { color: ringColor(p.score) } }, p.grade),
            h("span", { className: "text-[11px] font-semibold uppercase tracking-widest text-slate-500" }, "grade"),
          ),
          h("div", { className: "mt-2 text-[13px] leading-relaxed text-slate-400" },
            ftotal === 0
              ? "Account currently shows no findings."
              : `${ftotal} open finding${ftotal === 1 ? "" : "s"} · weighted exposure ${p.pen}.`,
          ),
          h("div", { className: "mt-3 flex flex-wrap items-center gap-2" },
            h("span", { className: "chip" }, h(Icon, { name: "box", className: "h-3.5 w-3.5 text-slate-400" }), summary.nodes ?? "-", " resources"),
            h("span", { className: "chip" }, h(Icon, { name: "graph", className: "h-3.5 w-3.5 text-slate-400" }), summary.edges ?? "-", " edges"),
            h("span", { className: "chip" }, h(Icon, { name: "dashboard", className: "h-3.5 w-3.5 text-slate-400" }), (summary.regions ?? []).length, " regions"),
          ),
        ),
      ),
      /* severity distribution */
      h("div", { className: "card p-5" },
        h("div", { className: "mb-3 flex items-baseline justify-between" },
          h("span", { className: "section-title" }, "Findings by severity"),
          h("button", { className: "btn-ghost", onClick: () => go("findings") }, "view all", h(Icon, { name: "arrowRight", className: "h-3.5 w-3.5" })),
        ),
        ftotal > 0
          ? h(Fragment, null,
              h("div", { className: "flex h-2.5 w-full overflow-hidden rounded-full bg-white/10" },
                sevRows.map((s) => h("div", {
                  key: s,
                  className: cx("h-full", { critical: "bg-red-400", high: "bg-orange-400", medium: "bg-amber-300", low: "bg-emerald-300", info: "bg-sky-300" }[s]),
                  style: { width: `${((fcounts[s] / ftotal) * 100).toFixed(1)}%` },
                })),
              ),
              h("div", { className: "mt-3 grid gap-1.5" },
                sevRows.map((s) => {
                  const sev = SEV[s];
                  return h("button", {
                    key: s, onClick: () => go("findings", { sev: s }),
                    className: "flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-left transition hover:bg-white/5",
                  },
                    h("span", { className: cx("sevdot", sev.dot) }),
                    h("span", { className: "flex-1 text-[12.5px] capitalize text-slate-400" }, s),
                    h("span", { className: "font-mono text-[13px] font-semibold text-slate-200" }, fcounts[s]),
                    h(Icon, { name: "chevron", className: "h-3.5 w-3.5 -rotate-90 text-slate-600" }),
                  );
                }),
              ),
            )
          : h("div", { className: "flex h-40 items-center justify-center text-sm text-slate-500" },
              "No findings on the latest snapshot."),
      ),
    ),

    h("div", { className: "mt-4 grid gap-4 lg:grid-cols-2" },
      /* resource mix */
      h("div", { className: "card p-5" },
        h("span", { className: "section-title" }, "Resource mix"),
        h("div", { className: "mt-3 space-y-2" },
          topMix.map(([label, count]) => h("div", { key: label, className: "flex items-center gap-3" },
            h("div", { className: "w-24 shrink-0 truncate font-mono text-[11.5px] text-slate-400" }, label),
            h("div", { className: "h-2 flex-1 overflow-hidden rounded-full bg-white/10" },
              h("div", { className: "h-full rounded-full", style: { width: `${((count / mixTotal) * 100).toFixed(0)}%`, background: COLORS[label] ?? "#64748b" } })),
            h("span", { className: "w-8 shrink-0 text-right font-mono text-[12px] text-slate-300" }, count),
          )),
          mix.length > topMix.length
            ? h("div", { className: "pt-1 text-[11.5px] text-slate-500" }, `+ ${mix.length - topMix.length} more labels (${mixTotal} total)`)
            : null,
        ),
      ),
      /* snapshot + account context */
      h("div", { className: "card p-5" },
        h("span", { className: "section-title" }, "Snapshot"),
        h("div", {
          className: "mt-3 grid gap-2 rounded-lg border border-white/5 bg-white/[0.02] p-3",
        },
          metaRow("snapshot", latest.id),
          metaRow("account", (summary.accounts ?? []).join(", ") || "—"),
          metaRow("regions", (summary.regions ?? []).join(", ") || "—"),
          metaRow("scanned", latest.summary?.finished_at ? fmtDT(latest.summary.finished_at) : "—"),
          metaRow("status", latest.summary?.status ?? "—"),
        ),
        h("div", { className: "mt-3 text-[11.5px] leading-relaxed text-slate-500" },
          "Posture is computed from the latest snapshot's findings. Re-run a scan after changes to refresh."),
      ),
    ),

    h("div", { className: "mt-4 grid gap-4 lg:grid-cols-2" },
      /* top risks */
      h("div", { className: "card p-5" },
        h("div", { className: "mb-3 flex items-baseline justify-between" },
          h("span", { className: "section-title" }, "Highest risk findings"),
          h("button", { className: "btn-ghost", onClick: () => go("findings") }, "all findings", h(Icon, { name: "arrowRight", className: "h-3.5 w-3.5" })),
        ),
        topFindings.length
          ? h("div", { className: "space-y-1.5" },
              topFindings.map((f) =>
                h("button", {
                  key: f.id,
                  onClick: () => go("findings", { sev: f.severity }),
                  className: "flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-white/5",
                },
                  h("span", { className: cx("sevdot", (SEV[f.severity] ?? SEV.info).dot) }),
                  h("span", { className: "min-w-0 flex-1" },
                    h("span", { className: "block truncate text-[13px] text-slate-200" }, f.message),
                    h("span", { className: "mt-0.5 flex items-center gap-2 text-[11px] text-slate-500" },
                      h("span", { className: "font-mono" }, f.rule),
                      h("span", { className: "truncate" }, f.resource_name || shortKey(f.resource_key)),
                    ),
                  ),
                  h(Icon, { name: "chevron", className: "h-3.5 w-3.5 -rotate-90 text-slate-600" }),
                )
              ),
            )
          : h("div", { className: "flex h-24 items-center justify-center text-sm text-emerald-300/80" },
              "No findings — great shape."),
      ),
      /* recent scans */
      h("div", { className: "card p-5" },
        h("div", { className: "mb-3 flex items-baseline justify-between" },
          h("span", { className: "section-title" }, "Recent scans"),
          h("button", { className: "btn-ghost", onClick: () => go("scans") }, "all scans", h(Icon, { name: "arrowRight", className: "h-3.5 w-3.5" })),
        ),
        recent.length
          ? h("div", { className: "space-y-1.5" },
              recent.map((j) =>
                h("button", {
                  key: j.id, onClick: () => go("scans"),
                  className: "flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-white/5",
                },
                  h("span", { className: cx("h-2 w-2 shrink-0 rounded-full", (JOB[j.status] ?? JOB.completed).dot) }),
                  h("span", { className: "min-w-0 flex-1 font-mono text-[12px] text-slate-300" }, shortKey(j.snapshot_id || j.id)),
                  h("span", { className: "text-[11px] text-slate-500" }, `${j.nodes ?? 0} nodes · ${j.edges ?? 0} edges`),
                  h("span", { className: "text-[11px] text-slate-500" }, timeAgo(j.finished_at || j.created_at)),
                )
              ),
            )
          : h("div", { className: "flex h-24 items-center justify-center text-sm text-slate-500" }, "No completed scans yet."),
      ),
    ),
  );
}

function metaRow(k, v) {
  return h("div", { key: k, className: "flex items-baseline justify-between gap-4" },
    h("span", { className: "kpi-label" }, k),
    h("span", { className: "min-w-0 truncate font-mono text-[12.5px] text-slate-300" }, v),
  );
}

/* ============================================================ */
/*  FINDINGS                                                      */
/* ============================================================ */
function Findings({ data, sev, setSev, onAsk }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [sort, setSort] = useState("sev");
  const [openId, setOpenId] = useState(null);

  const counts = data?.counts?.bySeverity ?? {};
  const categories = useMemo(() => {
    const s = new Set((data?.findings ?? []).map((f) => f.category).filter(Boolean));
    return ["all", ...s];
  }, [data]);

  const visible = useMemo(() => {
    let f = data?.findings ?? [];
    if (sev) f = f.filter((x) => x.severity === sev);
    if (cat !== "all") f = f.filter((x) => x.category === cat);
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      f = f.filter((x) =>
        (x.rule ?? "").toLowerCase().includes(t) ||
        (x.message ?? "").toLowerCase().includes(t) ||
        (x.resource_name ?? "").toLowerCase().includes(t) ||
        (x.resource_key ?? "").toLowerCase().includes(t)
      );
    }
    const idx = (s) => SEV_ORDER.indexOf(s) ?? 9;
    if (sort === "sev") f = [...f].sort((a, b) => idx(a.severity) - idx(b.severity) || a.rule.localeCompare(b.rule));
    if (sort === "rule") f = [...f].sort((a, b) => a.rule.localeCompare(b.rule));
    if (sort === "resource") f = [...f].sort((a, b) => (a.resource_name ?? "").localeCompare(b.resource_name ?? ""));
    return f;
  }, [data, sev, cat, q, sort]);

  if (!data) {
    return h("div", { className: "flex h-full items-center justify-center" },
      h("div", { className: "h-6 w-6 animate-spin rounded-full border-2 border-white/10 border-t-sky-400" }));
  }

  const sevChips = SEV_ORDER.filter((s) => counts[s] > 0);

  const exportUrl = (fmt) => {
    const p = new URLSearchParams({ format: fmt });
    if (sev) p.set("severity", sev);
    if (cat !== "all") p.set("category", cat);
    if (q.trim()) p.set("q", q.trim());
    if (data?.snapshot) p.set("snapshot", data.snapshot);
    return `/api/findings/export?${p}`;
  };

  return h("div", { className: "flex h-full flex-col" },
    h("div", { className: "shrink-0 border-b border-white/10 px-6 py-3" },
      h("div", { className: "flex flex-wrap items-center gap-2" },
        h("div", { className: "relative min-w-[220px] flex-1" },
          h(Icon, { name: "search", className: "pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" }),
          h("input", {
            className: "input pl-9",
            placeholder: "Search rule, message, resource…",
            value: q,
            onChange: (e) => setQ(e.target.value),
          }),
        ),
        h("button", { className: cx("toggle", !sev ? "toggle-on" : "toggle-off"), onClick: () => setSev(null) }, "all"),
        sevChips.map((s) =>
          h("button", { key: s, className: cx("toggle", sev === s ? "toggle-on" : "toggle-off"), onClick: () => setSev(s) },
            s,
            h("span", { className: "font-mono text-[11px]" }, counts[s]),
          )
        ),
        h("select", { className: "select", value: cat, onChange: (e) => setCat(e.target.value), title: "category" },
          categories.map((c) => h("option", { key: c, value: c }, c === "all" ? "all categories" : c)),
        ),
        h("select", { className: "select", value: sort, onChange: (e) => setSort(e.target.value), title: "sort" },
          h("option", { value: "sev" }, "severity"),
          h("option", { value: "rule" }, "rule"),
          h("option", { value: "resource" }, "resource"),
        ),
        // Export mirrors the active filters, so you get exactly the rows on screen.
        h("div", { className: "ml-auto flex items-center gap-1" },
          h("span", { className: "text-[11px] text-slate-500" }, "export"),
          ["csv", "md", "json"].map((fmt) =>
            h("a", {
              key: fmt,
              className: "toggle toggle-off",
              href: exportUrl(fmt),
              download: "",
              title: `Download ${visible.length} finding(s) as ${fmt.toUpperCase()}`,
            }, fmt)
          ),
        ),
      ),
      h("div", { className: "mt-2 text-[11.5px] text-slate-500" },
        h("span", { className: "font-semibold text-slate-300" }, visible.length), " of ", h("span", { className: "font-semibold text-slate-300" }, (data.counts?.total ?? 0) + (data.findings ?? []).length - (data.findings ?? []).length), " shown"
      ),
    ),
    h("div", { className: "min-h-0 flex-1 overflow-y-auto px-6 py-4" },
      data.findings.length === 0
        ? h("div", { className: "flex h-full flex-col items-center justify-center gap-2 text-center" },
            h("div", { className: "flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-400/10 text-emerald-300" }, h(Icon, { name: "alert", className: "h-6 w-6" })),
            h("div", { className: "text-sm font-medium text-slate-300" }, "No findings on the latest snapshot"),
            h("div", { className: "max-w-sm text-[12.5px] text-slate-500" }, "Run a scan to evaluate resources. New findings will appear here as they surface."),
            h("span", { className: "chip mt-2" }, "score the account, not the tool"),
          )
        : visible.length === 0
          ? h("div", { className: "flex h-full items-center justify-center text-sm text-slate-500" }, "Nothing matches the current filters.")
          : h("div", { className: "mx-auto max-w-4xl space-y-2" },
              visible.map((f) => {
                const sevC = SEV[f.severity] ?? SEV.info;
                const opened = openId === f.id;
                return h("div", {
                  key: f.id,
                  onClick: () => setOpenId(opened ? null : f.id),
                  className: cx(
                    "fade-in group cursor-pointer rounded-xl border px-4 py-3 transition",
                    opened ? "border-indigo-400/40 bg-indigo-500/5" : "border-white/10 bg-ink-850/70 hover:border-white/20 hover:bg-ink-800/60",
                  ),
                },
                  h("div", { className: "flex items-start gap-3" },
                    h("div", { className: "pt-1" },
                      h("span", { className: cx("sevdot h-2.5 w-2.5", sevC.dot) }),
                    ),
                    h("div", { className: "min-w-0 flex-1" },
                      h("div", { className: "text-[13.5px] font-medium leading-snug text-slate-100" }, f.message),
                      h("div", { className: "mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-slate-500" },
                        h("span", { className: cx("sevbadge", sevC.badge) }, f.severity),
                        h("span", { className: "font-mono text-slate-400" }, f.rule),
                        h("span", { className: "text-slate-400" }, f.resource_name || shortKey(f.resource_key)),
                        f.category ? h("span", { className: "capitalize" }, f.category) : null,
                        f.region ? h("span", null, f.region) : null,
                      ),
                    ),
                    h("div", { className: "flex shrink-0 items-center gap-1" },
                      h("button", {
                        className: cx("btn-ghost", "hidden sm:inline-flex"),
                        title: "Ask the copilot about this finding",
                        onClick: (e) => { e.stopPropagation(); onAsk(f); },
                      }, h(Icon, { name: "message", className: "h-3.5 w-3.5" }), "help"),
                      h(Icon, { name: "chevron", className: cx("h-4 w-4 text-slate-500 transition", opened && "rotate-180") }),
                    ),
                  ),
                  opened
                    ? h("div", { className: "mt-3 grid gap-4 border-t border-white/10 pt-3 sm:grid-cols-2" },
                        h("div", null,
                          h("div", { className: "kpi-label mb-1" }, "Remediation"),
                          h("p", { className: "text-[13px] leading-relaxed text-slate-300" }, f.remediation || "No remediation guidance recorded."),
                        ),
                        h("div", null,
                          h("div", { className: "kpi-label mb-1" }, "Context"),
                          h("div", { className: "space-y-1 font-mono text-[11.5px] text-slate-500" },
                            h("div", null, "resource: ", h("span", { className: "break-all text-slate-300" }, shortKey(f.resource_key))),
                            h("div", null, "key: ", h("span", { className: "break-all text-slate-400" }, f.resource_key)),
                            f.account_id ? h("div", null, "account: ", h("span", { className: "text-slate-300" }, f.account_id)) : null,
                            h("div", null, "category: ", h("span", { className: "text-slate-300" }, f.category)),
                          ),
                        ),
                      )
                    : null,
                );
              }),
              visible.length > (data.findings?.length ?? 0)
                ? null
                : h("div", { className: "pb-2 pt-3 text-center text-[11.5px] text-slate-600" }, "— end —"),
            ),
    ),
  );
}

/* ============================================================ */
/*  SCANS                                                         */
/* ============================================================ */
function fmtDur(ms) {
  if (!ms || isNaN(ms) || ms < 0) return "0:00";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Scans({ jobs, connected, run, act, scannedRegions }) {
  // Default to the regions the latest snapshot actually covered. Hardcoding
  // "us-east-1" produces a broken scan in any non-commercial partition
  // (GovCloud, China), where that region does not exist.
  const [regions, setRegions] = useState(scannedRegions || "us-east-1");
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    if (!pinned && scannedRegions) setRegions(scannedRegions);
  }, [scannedRegions, pinned]);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  // /api/jobs can answer with an error object (e.g. the scan daemon is not
  // running), so never assume this is an array — .find() on an object took the
  // whole SPA down.
  const list = Array.isArray(jobs) ? jobs : [];
  const live = list.find((j) => j.status === "queued" || j.status === "running" || j.status === "cancelling");
  const history = list.filter((j) => !["queued", "running", "cancelling"].includes(j.status));

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live?.id, live?.status]);

  const doRun = async () => {
    setBusy(true);
    try {
      await run(regions.split(",").map((s) => s.trim()).filter(Boolean));
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };
  const actRow = async (id, action) => {
    try { await act(id, action); } catch (e) { alert(e.message); }
  };
  const totalSteps = (j) => j.steps?.length ?? 0;
  const doneSteps = (j) => j.steps?.filter((s) => s.status === "completed").length ?? 0;
  const active = live?.steps?.find((s) => s.status === "running");

  return h("div", { className: "mx-auto grid max-w-6xl min-h-0 flex-1 gap-4 overflow-y-auto px-6 py-6 lg:grid-cols-3 fade-in" },
    /* left: active scan */
    h("div", { className: "space-y-4 lg:col-span-2" },
      live && live.status !== "cancelling"
        ? h("div", { className: "card p-5 fade-in" },
            h("div", { className: "flex flex-wrap items-center gap-2" },
              h("span", { className: "relative flex h-2.5 w-2.5" },
                h("span", { className: "absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" }),
                h("span", { className: "relative inline-flex h-2.5 w-2.5 rounded-full bg-sky-400" }),
              ),
              h("span", { className: "text-sm font-semibold text-slate-100" }, live.status === "queued" ? "Scan queued" : "Scan in progress"),
              h("code", { className: "font-mono text-[11px] text-slate-400" }, shortKey(live.snapshot_id || live.id)),
              h("span", { className: "ml-auto font-mono text-[11.5px] text-slate-500" }, `${doneSteps(live)} / ${totalSteps(live)} steps`),
            ),
            live.status === "running"
              ? h(Fragment, null,
                  h("div", { className: "prog mt-4" },
                    h("div", { className: "prog-fill", style: { width: `${totalSteps(live) ? Math.round((doneSteps(live) / totalSteps(live)) * 100) : 4}%` } })),
                  h("div", { className: "mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-slate-500" },
                    active ? h("span", null, "current: ", h("span", { className: "font-mono text-sky-300" }, active.service?.replaceAll("-", " ")), " · ", active.region) : h("span", null, "warming up…"),
                    h("span", null, "elapsed ", h("span", { className: "font-mono text-slate-300" }, fmtDur(now - Date.parse(live.started_at || live.created_at)))),
                    h("span", null, h("span", { className: "font-mono text-slate-300" }, live.nodes ?? 0), " nodes"),
                    h("span", null, h("span", { className: "font-mono text-slate-300" }, live.edges ?? 0), " edges"),
                  ),
                  h("div", { className: "mt-3 flex flex-wrap gap-1.5" },
                    (live.steps ?? []).map((s, i) =>
                      h("span", {
                        key: i,
                        title: `${s.service} · ${s.region} · ${s.status}`,
                        className: cx(
                          "rounded-md px-1.5 py-0.5 font-mono text-[10px] tracking-tight",
                          s.status === "completed" ? "bg-emerald-400/15 text-emerald-300" :
                          s.status === "running" ? "bg-sky-400/20 text-sky-200" :
                          s.status === "failed" ? "bg-red-400/15 text-red-300" :
                          "bg-white/5 text-slate-600",
                        ),
                      }, s.service.replaceAll("-", ".")),
                    ),
                  ),
                )
              : h("div", { className: "mt-3 text-[12.5px] text-slate-500" }, "Waiting for a worker slot…"),
            h("div", { className: "mt-4 flex items-center gap-2" },
              live.status === "running" || live.status === "queued"
                ? h("button", { className: "btn-danger", onClick: () => actRow(live.id, "cancel") }, h(Icon, { name: "stop", className: "h-3.5 w-3.5" }), "Cancel scan")
                : null,
            ),
          )
        : h("div", { className: "card flex h-56 flex-col items-center justify-center gap-2 border-dashed p-6 text-center" },
            h("div", { className: "flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5 text-slate-400" }, h(Icon, { name: "scan", className: "h-6 w-6" })),
            h("div", { className: "text-sm font-medium text-slate-300" }, "No active scan"),
            h("div", { className: "max-w-xs text-[12.5px] leading-relaxed text-slate-500" },
              "Trigger a scan to sweep 26 resource services across your selected regions, load the graph into Neo4j, and compute findings."),
          ),
      /* history */
      h("div", { className: "card p-5" },
        h("div", { className: "mb-3 flex items-baseline justify-between" },
          h("span", { className: "section-title" }, "History"),
          h("span", { className: "text-[11px] text-slate-500" }, (jobs ?? []).length, " jobs"),
        ),
        history.length
          ? h("div", { className: "space-y-1.5" },
              history.map((j) =>
                h("div", { key: j.id, className: "flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5 transition hover:bg-white/[0.04]" },
                  h("span", { className: cx("h-2 w-2 shrink-0 rounded-full", (JOB[j.status] ?? JOB.completed).dot) }),
                  h("div", { className: "min-w-0 flex-1" },
                    h("div", { className: "flex items-center gap-2" },
                      h("code", { className: "font-mono text-[11.5px] text-slate-300" }, shortKey(j.snapshot_id || j.id)),
                      h("span", { className: cx("text-[11px] font-medium capitalize", (JOB[j.status] ?? {}).txt ?? "text-slate-400") }, j.status),
                    ),
                    h("div", { className: "mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-slate-500" },
                      h("span", null, `${j.nodes ?? 0} nodes · ${j.edges ?? 0} edges`),
                      (j.regions?.length ? h("span", null, j.regions.join(", ")) : null),
                      h("span", null, fmtDT(j.finished_at || j.created_at)),
                    ),
                  ),
                  RESUMEABLE.includes(j.status)
                    ? h("button", { className: "btn", onClick: () => actRow(j.id, "resume") }, h(Icon, { name: "refresh", className: "h-3.5 w-3.5" }), "resume")
                    : null,
                ),
              ),
            )
          : h("div", { className: "py-6 text-center text-sm text-slate-500" }, "No scan history yet."),
      ),
    ),
    /* right: run control */
    h("div", { className: "space-y-4" },
      h("div", { className: "card space-y-3 p-5" },
        h("span", { className: "section-title" }, "New scan"),
        h("label", { className: "kpi-label" }, "Regions"),
        h("input", {
          className: "input font-mono",
          value: regions,
          onChange: (e) => { setPinned(true); setRegions(e.target.value); },
          placeholder: "us-east-1, eu-west-1, ap-south-1…",
        }),
        h("button", { className: "btn-primary w-full justify-center", disabled: busy, onClick: doRun },
          h(Icon, { name: busy ? "refresh" : "play", className: busy ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5" }),
          busy ? "Starting…" : "Scan now"),
        h("div", { className: "flex items-center gap-2 text-[11.5px] text-slate-400" },
          h("span", { className: cx("h-1.5 w-1.5 rounded-full", connected ? "bg-emerald-400" : "bg-slate-500") }),
          connected ? "scanner daemon live" : "scanner daemon offline",
        ),
        h("p", { className: "text-[11.5px] leading-relaxed text-slate-500" },
          "Streams results to Neo4j and stores a snapshot bundle under snapshots/. Jobs run in the background."),
      ),
    ),
  );
}

/* ============================================================ */
/*  COPILOT (Ask)                                                 */
/* ============================================================ */
const SUGGESTIONS = [
  "What is my overall security posture?",
  "Are any resources publicly exposed?",
  "Which resources are missing encryption?",
  "Is VPC flow logging enabled everywhere?",
  "What should I fix first?",
];

const PMETA = {
  heuristic: { label: "Heuristic", badge: "border-slate-400/30 bg-slate-400/10 text-slate-300" },
  anthropic: { label: "Claude",    badge: "border-orange-300/30 bg-orange-300/10 text-orange-200" },
  bedrock:   { label: "Bedrock",   badge: "border-orange-400/30 bg-orange-400/10 text-orange-300" },
  openrouter:{ label: "OpenRouter", badge: "border-sky-400/30 bg-sky-400/10 text-sky-300" },
  opencode:  { label: "opencode",  badge: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" },
};

const SKILL_META = {
  drift:    { label: "Drift",      icon: "drift", cls: "from-sky-500/20 to-cyan-950/40 text-cyan-300 ring-cyan-400/30", glow: "shadow-[0_0_14px_rgba(34,211,238,0.15)]" },
  findings: { label: "Findings",   icon: "alert", cls: "from-rose-500/20 to-rose-950/40 text-rose-300 ring-rose-400/30", glow: "shadow-[0_0_14px_rgba(251,113,133,0.15)]" },
  infra:    { label: "Infra view", icon: "graph", cls: "from-emerald-500/20 to-emerald-950/40 text-emerald-300 ring-emerald-400/30", glow: "shadow-[0_0_14px_rgba(52,211,153,0.15)]" },
};

function SkillChip({ id }) {
  const m = SKILL_META[id] ?? { label: id, icon: "scan", cls: "from-slate-500/20 to-slate-900/40 text-slate-300 ring-slate-400/30", glow: "" };
  return h("span",
    { className: `inline-flex items-center gap-1.5 rounded-lg border border-transparent bg-gradient-to-br px-2.5 py-1 font-mono text-[10.5px] font-semibold uppercase tracking-wider ring-1 ${m.cls} ${m.glow}` },
    h(Icon, { name: m.icon, className: "h-3 w-3" }),
    m.label,
  );
}

function Ask({ log, busy, onSend, provider, setProvider, lastAsst, oc, ocBusy, ocRun, prefill, onConsumePrefill }) {
  const [q, setQ] = useState("");
  const endRef = useRef(null);

  useEffect(() => {
    if (prefill) {
      setQ(prefill);
      onConsumePrefill();
    }
  }, [prefill]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [log, busy]);

  const send = () => {
    const question = q.trim();
    if (!question || busy) return;
    onSend(question);
    setQ("");
  };

  const managed = oc?.managed;
  const showOc = provider === "opencode" || managed?.running;

  return h("div", { className: "flex h-full flex-col" },
    h("div", { className: "min-h-0 flex-1 overflow-y-auto px-4 py-4" },
      h("div", { className: "mx-auto flex max-w-3xl flex-col gap-3" },
        log.length === 0
          ? h("div", { className: "fade-in flex flex-col items-center gap-4 pt-8 text-center" },
              h("div", { className: "flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/15 text-indigo-300" }, h(Icon, { name: "message", className: "h-7 w-7" })),
              h("div", null,
                h("div", { className: "text-base font-semibold text-slate-100" }, "Ask about your infrastructure"),
                h("div", { className: "mt-1 max-w-md text-[13px] text-slate-500" },
                  "Grounded in the Neo4j graph and latest snapshot. Try one of these:"),
              ),
              h("div", { className: "grid w-full max-w-lg gap-2 sm:grid-cols-2" },
                SUGGESTIONS.map((s) =>
                  h("button", { key: s, className: "btn justify-start text-left", onClick: () => onSend(s) },
                    h(Icon, { name: "zap", className: "h-3.5 w-3.5 shrink-0 text-indigo-300" }),
                    h("span", { className: "truncate" }, s),
                  ),
                ),
              ),
            )
          : log.map((m, i) =>
              m.role === "user"
                ? h("div", { key: i, className: "bubble-user max-w-[85%] self-end whitespace-pre-wrap" }, m.text)
                : h("div", { key: i, className: "fade-in max-w-[85%] self-start" },
                    h("div", { className: "mb-1 flex flex-wrap items-center gap-1.5 px-1" },
                      h("span", { className: `inline-flex items-center gap-1 rounded-full border px-2 py-px font-mono text-[10.5px] font-medium tracking-wide ${PMETA[m.provider]?.badge ?? "border-white/15 bg-white/5 text-slate-400"}` }, PMETA[m.provider]?.label ?? m.provider ?? "assistant"),
                      m.model ? h("span", { className: "font-mono text-[10.5px] text-slate-500" }, m.model) : null,
                      m.latency != null ? h("span", { className: "text-[10.5px] text-slate-600" }, `${(m.latency / 1000).toFixed(1)}s`) : null,
                      m.context ? h("span", { className: "text-[10.5px] text-slate-600" }, `${m.context.resources > 0 ? m.context.resources + " resources · " : ""}${m.context.findings} findings`) : null,
                      m.note
                        ? h("span", { className: "inline-flex items-center gap-1 rounded-full border border-amber-400/20 bg-amber-400/10 px-2 py-px font-mono text-[10.5px] text-amber-300/90" }, m.note)
                        : null,
                    ),
                    m.context?.skills?.length
                      ? h("div", { className: "mb-1.5 flex flex-wrap items-center gap-1.5 px-1" },
                          m.context.skills.map((sk) => h(SkillChip, { key: sk, id: sk })),
                        )
                      : null,
                    h("div", { className: "bubble-ai" },
                      h(Md, { text: m.text, className: "fade-in" }),
                    ),
                  ),
            ),
        busy
          ? h("div", { className: "bubble-ai max-w-[85%] self-start" },
              h("div", { className: "flex items-center gap-2 text-slate-400" },
                h("span", { className: "text-[12px]" }, "Thinking"),
                h("span", { className: "flex gap-0.5" },
                  [0, 1, 2].map((i) => h("span", {
                    key: i,
                    className: "h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400",
                    style: { animationDelay: `${i * 0.15}s` },
                  })),
                ),
              ),
            )
          : null,
        h("div", { ref: endRef }),
      ),
    ),
    h("div", { className: "shrink-0 border-t border-white/10 px-4 pb-4 pt-3" },
      h("div", { className: "mx-auto max-w-3xl" },
        h("div", { className: "flex items-center gap-2 rounded-xl border border-white/10 bg-ink-900 p-2 focus-within:border-indigo-400/40 focus-within:ring-2 focus-within:ring-indigo-400/20" },
          h("input", {
            className: "min-w-0 flex-1 bg-transparent px-2 text-sm text-slate-200 outline-none placeholder:text-slate-600",
            placeholder: "Ask about posture, exposure, encryption, flow logs, or a specific resource…",
            value: q,
            onChange: (e) => setQ(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") send(); },
          }),
          h("select", { className: "select shrink-0", value: provider, onChange: (e) => setProvider(e.target.value), title: "provider" },
            h("option", { value: "auto" }, "auto"),
            ["heuristic", "anthropic", "bedrock", "openrouter", "opencode"].map((p) => h("option", { key: p, value: p }, p)),
          ),
          h("button", { className: "btn-primary shrink-0", disabled: busy || !q.trim(), onClick: send },
            busy ? h(Icon, { name: "refresh", className: "h-3.5 w-3.5 animate-spin" }) : h(Icon, { name: "arrowRight", className: "h-3.5 w-3.5" }),
            h("span", { className: "hidden sm:inline" }, busy ? "Thinking" : "Ask"),
          ),
        ),
        h("div", { className: "mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-slate-500" },
          h("span", null, "Engine:", " ", h("span", { className: "font-medium text-slate-300" }, provider === "auto" ? "auto" : PMETA[provider]?.label ?? provider)),
          lastAsst
            ? h(Fragment, null,
                h("span", null, "resolved: ", h("span", { className: "font-medium text-slate-300" }, PMETA[lastAsst.provider]?.label ?? lastAsst.provider)),
                lastAsst.model ? h("span", null, " · ", lastAsst.model) : null,
                lastAsst.context ? h("span", null, ` · ${lastAsst.context.resources > 0 ? lastAsst.context.resources + " resources " : ""}· ${lastAsst.context.findings} findings`) : null,
                lastAsst.context?.skills?.length
                  ? h("span", { className: "flex flex-wrap items-center gap-1.5" },
                      lastAsst.context.skills.map((sk) => h(SkillChip, { key: sk, id: sk })),
                    )
                  : null,
              )
            : h("span", { className: "text-slate-600" }, "send a question to see what answered"),
        ),
        showOc
          ? h("div", { className: "mt-2 flex items-center gap-2 px-1" },
              h("span", { className: cx("h-1.5 w-1.5 shrink-0 rounded-full", managed?.running ? "bg-emerald-400" : "bg-slate-500") }),
              h("span", { className: "min-w-0 flex-1 truncate font-mono text-[11px] text-slate-500" },
                managed?.running ? `opencode agent @ ${managed.url}` : "opencode agent stopped"),
              h("button", {
                className: "btn !py-1 text-[11px]",
                onClick: () => ocRun(!managed?.running),
                disabled: ocBusy,
              }, ocBusy ? "…" : managed?.running ? "stop" : "start"),
            )
          : null,
      ),
    ),
  );
}

/* ============================================================ */
/*  DRIFT (Diff)                                                  */
/* ============================================================ */
function DeepJson({ v }) {
  if (v === null || v === undefined) return h("span", { className: "font-mono text-slate-500" }, "\u2205");
  let s;
  if (typeof v === "object") {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  } else { s = String(v); }
  if (s.length > 220) s = s.slice(0, 220) + "\u2026";
  return h("span", { className: "font-mono break-all text-slate-300" }, s);
}

function LineRows({ lines }) {
  return lines.map((l, i) => {
    if (l.status === "same") {
      return h("div", { key: i, className: "flex gap-2 px-3 py-px font-mono text-[12px] leading-relaxed text-slate-600" },
        h("span", { className: "w-4 shrink-0 text-center" }, " "),
        h("span", { className: "min-w-[130px] text-slate-500" }, l.path),
        h(DeepJson, { v: l.to }));
    }
    if (l.status === "add") {
      return h("div", { key: i, className: "flex gap-2 bg-emerald-500/10 px-3 py-px font-mono text-[12px] leading-relaxed" },
        h("span", { className: "w-4 shrink-0 text-center font-bold text-emerald-400" }, "+"),
        h("span", { className: "min-w-[130px] text-emerald-200/80" }, l.path),
        h(DeepJson, { v: l.to }));
    }
    if (l.status === "del") {
      return h("div", { key: i, className: "flex gap-2 bg-red-500/10 px-3 py-px font-mono text-[12px] leading-relaxed" },
        h("span", { className: "w-4 shrink-0 text-center font-bold text-red-400" }, "\u2212"),
        h("span", { className: "min-w-[130px] text-red-200/70" }, l.path),
        h(DeepJson, { v: l.from }));
    }
    return h(Fragment, { key: i },
      h("div", { className: "flex gap-2 bg-red-500/10 px-3 py-px font-mono text-[12px] leading-relaxed" },
        h("span", { className: "w-4 shrink-0 text-center font-bold text-red-400" }, "\u2212"),
        h("span", { className: "min-w-[130px] text-red-200/70" }, l.path),
        h(DeepJson, { v: l.from })),
      h("div", { className: "flex gap-2 bg-emerald-500/10 px-3 py-px font-mono text-[12px] leading-relaxed" },
        h("span", { className: "w-4 shrink-0 text-center font-bold text-emerald-400" }, "+"),
        h("span", { className: "min-w-[130px] text-emerald-200/80" }, l.path),
        h(DeepJson, { v: l.to })),
    );
  });
}

function AttrChip({ a }) {
  if (!a) return null;
  const who = a.user_arn || a.username || a.access_key_id || "unknown";
  return h("span", {
    className: "inline-flex items-center gap-1 rounded-full border border-amber-400/20 bg-amber-400/10 px-2 py-0.5 font-mono text-[10.5px] text-amber-200/90",
    title: `${a.event_time}${a.source_ip ? " \u00b7 from " + a.source_ip : ""}`,
  },
    h(Icon, { name: "key", className: "h-3 w-3" }),
    a.event_name,
    " \u00b7 ",
    who);
}

const DIFF_COLOR = {
  add: { chip: "text-emerald-400", ring: "border-emerald-400/40 bg-emerald-400/10", txt: "text-emerald-300" },
  del: { chip: "text-red-400",     ring: "border-red-400/40 bg-red-400/10",     txt: "text-red-300" },
  chg: { chip: "text-amber-300",   ring: "border-amber-300/40 bg-amber-300/10", txt: "text-amber-200" },
};

function ResourceBlock({ it, color, opened, onToggle }) {
  const c = DIFF_COLOR[color];
  const chip = color === "add" ? "+" : color === "del" ? "\u2212" : "~";
  const short = (k) => (k ?? "").split("/").pop();
  return h("div", {
    className: cx("overflow-hidden rounded-xl border transition", opened ? c.ring : "border-white/10 bg-ink-850/70"),
  },
    h("div", { onClick: onToggle, className: "flex cursor-pointer select-none items-center gap-2.5 px-3.5 py-2.5 transition hover:bg-white/5" },
      h("span", { className: cx("text-[13px] font-bold", c.chip) }, chip),
      h("span", { className: "text-[11px] font-semibold uppercase tracking-widest text-slate-500" }, it.label),
      h("span", { className: "min-w-0 flex-1 truncate font-mono text-[12.5px] text-slate-200" }, it.name || short(it.key)),
      h("span", { className: "hidden font-mono text-[11px] text-slate-500 sm:inline" }, short(it.key)),
      h(AttrChip, { a: it.attributed_by }),
      h(Icon, { name: "chevron", className: cx("h-4 w-4 shrink-0 text-slate-500 transition", opened && "rotate-180") }),
    ),
    opened
      ? h("div", { className: "max-h-96 overflow-y-auto border-t border-white/10 py-1" }, h(LineRows, { lines: it.lines }))
      : null,
  );
}

function DiffGroup({ title, count, items, color, open, toggle }) {
  if (!count) return null;
  const c = DIFF_COLOR[color];
  return h("div", { className: "space-y-1.5" },
    h("div", { className: "flex items-center gap-2 pt-4 pb-1.5" },
      h("span", { className: cx("h-2 w-2 rounded-full", { add: "bg-emerald-400", del: "bg-red-400", chg: "bg-amber-300" }[color]) }),
      h("h3", { className: "text-[11px] font-semibold uppercase tracking-widest text-slate-400" }, title),
      h("span", { className: cx("font-mono text-[11px]", c.chip) }, count),
    ),
    items.map((it) => h(ResourceBlock, { key: it.key, it, color, opened: !!open[it.key], onToggle: () => toggle(it.key) })),
    count > items.length
      ? h("div", { className: "px-1 pt-1 text-[11px] text-slate-600" }, `\u2026 and ${count - items.length} more not shown`)
      : null,
  );
}

function Diff() {
  const [snaps, setSnaps] = useState([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState({});

  useEffect(() => {
    fetch("/api/snapshots").then((r) => r.json()).then((s) => {
      setSnaps(s);
      setFrom(s.length > 1 ? s[1].id : s[0]?.id ?? "");
      setTo(s[0]?.id ?? "");
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!from || !to || from === to) { setData(null); return; }
    fetch(`/api/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((r) => r.json()).then((d) => { setData(d.error ? null : d); setErr(d.error ?? null); setOpen({}); })
      .catch((e) => setErr(String(e)));
  }, [from, to]);

  const swap = () => { setFrom(to); setTo(from); };
  const toggle = (key) => setOpen((o) => ({ ...o, [key]: !o[key] }));
  const allOpen = Object.values(open).reduce((a, b) => a && b, Object.keys(open).length > 0);
  const setAll = (v) => {
    const next = {};
    for (const s of [...data?.nodes_added.items ?? [], ...data?.nodes_removed.items ?? [], ...data?.nodes_changed.items ?? []]) next[s.key] = v;
    setOpen(next);
  };

  const doExport = async (fmt) => {
    const r = await fetch(`/api/diff/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&format=${fmt}`);
    const blob = await r.blob();
    const aEl = document.createElement("a");
    aEl.href = URL.createObjectURL(blob);
    aEl.download = `awsome-drift-${from}-to-${to}.${fmt === "md" ? "md" : "json"}`;
    aEl.click();
    URL.revokeObjectURL(aEl.href);
  };

  const fm = data?.meta?.from, tm = data?.meta?.to;
  const owner = (m) => m ? `${m.user ?? "?"}@${m.hostname ?? "?"} (${m.trigger ?? "manual"})` : "?";
  const c = data?.counts;
  const statCard = (label, n, cls) =>
    h("div", { className: "card px-3 py-2.5" },
      h("div", { className: cx("font-mono text-xl font-bold", cls) }, n),
      h("div", { className: "kpi-label" }, label));

  return h("div", { className: "flex h-full flex-col" },
    h("div", { className: "shrink-0 border-b border-white/10 px-6 py-3" },
      h("div", { className: "flex flex-wrap items-center gap-2" },
        h("label", { className: "kpi-label" }, "From"),
        h("select", { className: "select font-mono text-[11.5px]", value: from, onChange: (e) => setFrom(e.target.value) },
          snaps.map((s) => h("option", { key: s.id, value: s.id }, s.id))),
        h("button", { className: "btn-ghost p-1.5", title: "swap", onClick: swap }, h(Icon, { name: "swap", className: "h-4 w-4" })),
        h("label", { className: "kpi-label" }, "To"),
        h("select", { className: "select font-mono text-[11.5px]", value: to, onChange: (e) => setTo(e.target.value) },
          snaps.map((s) => h("option", { key: s.id, value: s.id }, s.id))),
        h("span", { className: "mx-1 hidden h-5 w-px bg-white/10 sm:inline" }),
        h("span", { className: "chip text-emerald-300" }, "+ added"),
        h("span", { className: "chip text-red-300" }, "\u2212 removed"),
        h("span", { className: "chip text-amber-200" }, "~ changed"),
        h("span", { className: "flex-1" }),
        data
          ? h(Fragment, null,
              h("button", { className: "btn", onClick: () => setAll(!allOpen) }, allOpen ? "collapse all" : "expand all"),
              h("button", { className: "btn", onClick: () => doExport("md") }, h(Icon, { name: "download", className: "h-3.5 w-3.5" }), ".md"),
              h("button", { className: "btn", onClick: () => doExport("json") }, h(Icon, { name: "download", className: "h-3.5 w-3.5" }), ".json"),
            )
          : null,
      ),
      data
        ? h("div", { className: "mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500" },
            h("span", { className: "font-mono" }, `taken ${owner(fm)}  \u2192  taken ${owner(tm)}`),
            data.trail?.attributed
              ? h("span", { className: "inline-flex items-center gap-1 rounded-full border border-amber-400/20 bg-amber-400/10 px-2 py-0.5 font-mono text-[10.5px] text-amber-200/90" },
                  h(Icon, { name: "key", className: "h-3 w-3" }), `${data.trail.attributed} changes attributed via CloudTrail`)
              : h("span", { className: "font-mono text-slate-600" },
                  `trail: ${data.trail?.available_from ? data.trail.events_from + " ev" : "unavailable"} \u2192 ${data.trail?.available_to ? data.trail.events_to + " ev" : "unavailable"}`),
          )
        : null,
    ),
    h("div", { className: "min-h-0 flex-1 overflow-y-auto px-6 py-4" },
      data
        ? h("div", { className: "mx-auto max-w-5xl" },
            h("div", { className: "grid grid-cols-4 gap-3 sm:grid-cols-8" },
              statCard("added", c.nodes_added, "text-emerald-400"),
              statCard("removed", c.nodes_removed, "text-red-400"),
              statCard("changed", c.nodes_changed, "text-amber-300"),
              statCard("edges +", c.edges_added, "text-emerald-400"),
              statCard("edges \u2212", c.edges_removed, "text-red-400"),
              statCard("findings +", c.findings_added, "text-emerald-400"),
              statCard("findings \u2212", c.findings_removed, "text-red-400"),
              statCard("findings ~", c.findings_changed, "text-amber-300"),
            ),
            h(DiffGroup, { title: "Added resources", count: c.nodes_added, items: data.nodes_added.items, color: "add", open, toggle }),
            h(DiffGroup, { title: "Removed resources", count: c.nodes_removed, items: data.nodes_removed.items, color: "del", open, toggle }),
            h(DiffGroup, { title: "Changed resources", count: c.nodes_changed, items: data.nodes_changed.items, color: "chg", open, toggle }),
            (c.edges_added || c.edges_removed)
              ? h("div", { className: "space-y-1.5" },
                  h("div", { className: "flex items-center gap-2 pt-4 pb-1.5" },
                    h("span", { className: "h-2 w-2 rounded-full bg-emerald-400" }),
                    h("h3", { className: "text-[11px] font-semibold uppercase tracking-widest text-slate-400" }, "Edges"),
                    h("span", { className: "font-mono text-[11px] text-emerald-400" }, `+${c.edges_added}`),
                    h("span", { className: "font-mono text-[11px] text-red-400" }, `\u2212${c.edges_removed}`),
                  ),
                  data.edges_added.items.map((e) => h(edgeRow, { key: e.from + e.to + e.type, e, color: "add" })),
                  data.edges_removed.items.map((e) => h(edgeRow, { key: e.from + e.to + e.type, e, color: "del" })),
                )
              : null,
            (c.findings_added || c.findings_removed || c.findings_changed)
              ? h("div", { className: "space-y-1.5" },
                  h("div", { className: "flex items-center gap-2 pt-4 pb-1.5" },
                    h("span", { className: "h-2 w-2 rounded-full bg-indigo-400" }),
                    h("h3", { className: "text-[11px] font-semibold uppercase tracking-widest text-slate-400" }, "Findings"),
                    h("span", { className: "font-mono text-[11px] text-emerald-400" }, `+${c.findings_added}`),
                    h("span", { className: "font-mono text-[11px] text-red-400" }, `\u2212${c.findings_removed}`),
                    h("span", { className: "font-mono text-[11px] text-amber-300" }, `~${c.findings_changed}`),
                  ),
                  [...data.findings_added.items.map((f) => [f, "add"]),
                   ...data.findings_removed.items.map((f) => [f, "del"]),
                   ...data.findings_changed.items.map((f) => [f, "chg"])]
                    .map(([f, colr]) => h(findingRow, { key: f.id, f, color: colr })),
                )
              : null,
            !c.nodes_added && !c.nodes_removed && !c.nodes_changed && !c.edges_added && !c.edges_removed && !c.findings_added && !c.findings_removed && !c.findings_changed
              ? h("div", { className: "flex h-48 flex-col items-center justify-center gap-2 text-center" },
                  h("Icon", { name: "drift", className: "h-8 w-8 text-emerald-300/70" }),
                  h("div", { className: "text-sm font-medium text-slate-300" }, "No drift between these snapshots"),
                  h("div", { className: "text-[12px] text-slate-500" }, "The account state is identical."),
                )
              : null,
          )
        : err
          ? h("div", { className: "mx-auto max-w-5xl pt-16 text-center text-sm text-slate-500" }, `diff: ${err}`)
          : h("div", { className: "flex h-full items-center justify-center text-sm text-slate-500" }, "pick two snapshots or run a scan first"),
    ),
  );
}

function edgeRow({ e, color }) {
  const txt = color === "add" ? "text-emerald-300" : "text-red-300";
  return h("div", { className: "flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 font-mono text-[12px]" },
    h("span", { className: cx("font-bold", { add: "text-emerald-400", del: "text-red-400" }[color]) }, color === "add" ? "+" : "\u2212"),
    h("span", { className: "truncate text-slate-300" }, shortKey(e.from)),
    h("span", { className: "shrink-0 text-slate-500" }, `\u2013[${e.type}]\u2192`),
    h("span", { className: "truncate text-slate-300" }, shortKey(e.to)),
  );
}

function findingRow({ f, color }) {
  const sevC = SEV[f.severity] ?? SEV.info;
  return h("div", { className: "flex items-center gap-2.5 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-[12.5px]" },
    h("span", { className: cx("font-bold", { add: "text-emerald-400", del: "text-red-400", chg: "text-amber-300" }[color]) }, { add: "+", del: "\u2212", chg: "~" }[color]),
    h("span", { className: cx("sevdot", sevC.dot) }),
    h("span", { className: "min-w-0 flex-1 truncate font-mono text-slate-300" }, f.rule),
    h("span", { className: "hidden truncate text-slate-500 sm:inline" }, f.resource_name || shortKey(f.resource_key)),
    h(AttrChip, { a: f.attributed_by }),
  );
}

/* ============================================================ */
/*  APP SHELL                                                     */
/* ============================================================ */
const NAV = [
  { label: "Overview", items: [["summary", "Summary", "dashboard"]] },
  { label: "Investigate", items: [["diagram", "Graph", "graph"], ["findings", "Findings", "alert"], ["diff", "Drift", "drift"]] },
  { label: "Operate", items: [["scans", "Scans", "scan"]] },
  { label: "Assist", items: [["ask", "Copilot", "message"]] },
];
const PAGE = {
  summary: ["Summary", "Security posture across your account"],
  diagram: ["Graph", "Resource topology rendered from Neo4j"],
  findings: ["Findings", "Issues and controls on the latest snapshot"],
  scans: ["Scans", "Snapshot pipeline and job history"],
  diff: ["Drift", "Snapshot-to-snapshot change detector"],
  ask: ["Copilot", "Grounded answers about your infrastructure"],
};

function App() {
  const [tab, setTab] = useState("summary");
  const [summary, setSummary] = useState(null);
  const [graph, setGraph] = useState(null);
  const [findings, setFindings] = useState(null);
  const [jobs, setJobs] = useState(null);
  const [wsOk, setWsOk] = useState(false);
  const [showFindings, setShowFindings] = useState(false);
  // Architecture is the default: the containment view is what people mean by
  // "the diagram". Flow stays available for dependency tracing.
  const [diagView, setDiagView] = useState("component");
  const [findingGraph, setFindingGraph] = useState(null);
  const [snaps, setSnaps] = useState([]);
  const [showDiffOv, setShowDiffOv] = useState(false);
  const [diffOv, setDiffOv] = useState(null);
  const [dfrom, setDFrom] = useState("");
  const [dto, setDTo] = useState("");
  const [findingSev, setFindingSev] = useState(null);
  const [askLog, setAskLog] = useState([]);
  const [askBusy, setAskBusy] = useState(false);
  const [askProvider, setAskProvider] = useState("auto");
  const [askPrefill, setAskPrefill] = useState(null);
  const [oc, setOc] = useState(null);
  const [ocBusy, setOcBusy] = useState(false);

  useEffect(() => {
    fetch("/api/snapshots").then((r) => r.json()).then((s) => {
      setSnaps(s);
      setDFrom(s.length > 1 ? s[1].id : s[0]?.id ?? "");
      setDTo(s[0]?.id ?? "");
    }).catch(() => {});
    fetch("/api/opencode").then((r) => r.json()).then(setOc).catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/summary").then((r) => r.json()).then(setSummary).catch(console.error);
    // An error response still parses as JSON, so .catch() never fires — keep
    // jobs an array no matter what the endpoint answers.
    fetch("/api/jobs").then((r) => r.json())
      .then((d) => setJobs(Array.isArray(d) ? d : []))
      .catch(() => setJobs([]));
    fetch("/api/findings").then((r) => r.json()).then(setFindings).catch(() => {});
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/events`);
    ws.onopen = () => setWsOk(true);
    ws.onclose = () => setWsOk(false);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "jobs" && Array.isArray(msg.jobs)) {
          setJobs((prev) => {
            const before = new Map((prev ?? []).map((j) => [j.id, j.status]));
            const after = new Map(msg.jobs.map((j) => [j.id, j.status]));
            let settled = false;
            for (const [id, st] of before) {
              if (st && (st === "queued" || st === "running" || st === "cancelling") && after.get(id) !== st) settled = true;
            }
            if (settled) {
              fetch("/api/summary").then((r) => r.json()).then(setSummary).catch(() => {});
              fetch("/api/findings").then((r) => r.json()).then(setFindings).catch(() => {});
            }
            return msg.jobs;
          });
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => ws.close();
  }, []);

  const go = (name, arg) => {
    if (name === "findings") { setFindingSev(arg?.sev ?? null); setTab("findings"); return; }
    if (name === "ask") { if (arg?.q) setAskPrefill(arg.q); setTab("ask"); return; }
    setTab(name);
  };

  const askAbout = (f) =>
    go("ask", { q: `Explain finding "${f.rule}" on ${f.resource_name || shortKey(f.resource_key)} and how I fix it.` });

  const run = async (regions) => {
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ regions }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? `scan failed (${res.status})`);
    const job = await res.json();
    setJobs((prev) => [job, ...(prev ?? [])]);
  };
  const act = async (id, action) => {
    const res = await fetch(`/api/jobs/${id}/${action}`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error ?? `${action} failed`);
    const job = await res.json();
    setJobs((prev) => prev.map((j) => j.id === job.id ? job : j));
  };

  const askSend = async (question) => {
    if (!question.trim() || askBusy) return;
    setAskLog((l) => [...l, { role: "user", text: question }]);
    setAskBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, provider: askProvider !== "auto" ? askProvider : undefined }),
      });
      const d = await res.json();
      setAskLog((l) => [...l, { role: "assistant", text: d.answer ?? d.error, provider: d.provider, model: d.model, latency: d.latency_ms, context: d.context, note: d.note }]);
    } catch (e) {
      setAskLog((l) => [...l, { role: "assistant", text: `error: ${e.message}`, provider: "error" }]);
    } finally {
      setAskBusy(false);
    }
  };

  const ocRun = async (start) => {
    setOcBusy(true);
    try {
      const r = await fetch(start ? "/api/opencode/start" : "/api/opencode/stop", { method: "POST" }).then((r) => r.json());
      setOc((o) => (o ? { ...o, managed: r } : o));
    } catch { /* keep state */ }
    setOcBusy(false);
    try { setOc(await fetch("/api/opencode").then((r) => r.json())); } catch { /* ignore */ }
  };

  const toggleFindings = async () => {
    const next = !showFindings;
    setShowFindings(next);
    if (next && !findingGraph) {
      try { const r = await fetch("/api/graph/findings"); setFindingGraph(await r.json()); } catch { /* ignore */ }
    }
  };
  // FlowCanvas owns the export handlers because it owns the laid-out nodes; the
  // toolbar reaches them through here, and awaits them so a report that has to
  // fetch its drift comparison first still shows progress.
  const exportRef = useRef(null);
  const [exportBusy, setExportBusy] = useState(null);
  const runExport = async (kind) => {
    setExportBusy(kind);
    try { await exportRef.current?.[kind]?.(); } finally { setExportBusy(null); }
  };
  const loadDiffOv = async (f, t) => {
    const r = await fetch(`/api/diff?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`);
    const d = await r.json();
    if (d.error) return null;
    setDiffOv(d);
    return d;
  };
  // Used by the HTML export, which carries the drift view whether or not the
  // overlay was ever switched on. Defaults to the two most recent snapshots,
  // the same pair the overlay toggle picks.
  const ensureDrift = async () => {
    if (diffOv) return diffOv;
    const f = dfrom || snaps[1]?.id, t = dto || snaps[0]?.id;
    if (!f || !t || f === t) return null;
    return await loadDiffOv(f, t);
  };
  const toggleDiffOv = async () => {
    const next = !showDiffOv;
    setShowDiffOv(next);
    if (next) {
      const f = dfrom || snaps[1]?.id, t = dto || snaps[0]?.id;
      if (f && t && f !== t) await loadDiffOv(f, t);
    }
  };
  const onDFrom = (e) => { const v = e.target.value; setDFrom(v); if (showDiffOv && v && dto && v !== dto) loadDiffOv(v, dto); };
  const onDTo = (e) => { const v = e.target.value; setDTo(v); if (showDiffOv && dfrom && v && dfrom !== v) loadDiffOv(dfrom, v); };

  useEffect(() => {
    if (tab !== "diagram") return;
    fetch("/api/graph").then((r) => r.json()).then(setGraph).catch(console.error);
  }, [tab]);

  useEffect(() => {
    if (tab !== "findings") return;
    fetch("/api/findings").then((r) => r.json()).then(setFindings).catch(console.error);
  }, [tab]);

  const p = posture(summary?.findings);
  const ftotal = summary?.findings?.total ?? 0;
  const latest = summary?.latest_snapshot;
  const [ptitle, psub] = PAGE[tab] ?? ["", ""];
  const lastAsst = [...askLog].reverse().find((m) => m.role === "assistant") ?? null;
  const pane = (key, children) =>
    h("div", { className: cx("h-full", tab === key ? "flex flex-col" : "hidden") }, children);

  return h("div", { className: "flex h-screen overflow-hidden" },
    /* sidebar */
    h("aside", { className: "flex w-60 shrink-0 flex-col border-r border-white/10 bg-ink-900/70" },
      h("div", { className: "flex items-center gap-3 px-4 pb-4 pt-5" },
        h("div", { className: "flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-sky-400 font-mono text-sm font-bold text-white shadow-lg shadow-indigo-950/60" }, "A"),
        h("div", { className: "leading-tight" },
          h("div", { className: "text-[15px] font-bold tracking-tight text-slate-100" }, "AWSome"),
          h("div", { className: "text-[10.5px] uppercase tracking-widest text-slate-500" }, "infra intelligence"),
        ),
      ),
      h("nav", { className: "flex-1 space-y-4 overflow-y-auto px-3 py-2" },
        NAV.map((group) =>
          h("div", { key: group.label },
            h("div", { className: "kpi-label px-3 pb-1.5" }, group.label),
            group.items.map(([key, label, icon]) =>
              h("button", { key, className: cx("navitem", tab === key && "navitem-active"), onClick: () => setTab(key) },
                h(Icon, { name: icon, className: cx("h-4 w-4", tab === key ? "text-indigo-300" : "text-slate-500") }),
                label),
            ),
          ),
        ),
      ),
      h("div", { className: "space-y-1.5 border-t border-white/10 p-3" },
        h("div", { className: "flex items-center gap-2 px-1 text-[11px] text-slate-500" },
          h("span", { className: cx("h-1.5 w-1.5 rounded-full", summary?.neo4j?.url ? "bg-emerald-400" : "bg-slate-500") }),
          summary?.neo4j?.url ? "neo4j connected" : "neo4j offline",
        ),
        h("div", { className: "flex items-center gap-2 px-1 text-[11px] text-slate-500" },
          h("span", { className: cx("h-1.5 w-1.5 rounded-full", wsOk ? "bg-emerald-400" : "bg-slate-500") }),
          wsOk ? "scanner live" : "scanner offline",
        ),
        latest
          ? h("div", { className: "mt-1 truncate font-mono text-[10px] text-slate-600" }, latest.id)
          : h("div", { className: "mt-1 px-1 text-[10px] text-slate-600" }, "no snapshot yet"),
      ),
    ),
    /* main column */
    h("div", { className: "flex min-w-0 flex-1 flex-col" },
      h("header", { className: "flex h-14 shrink-0 items-center justify-between gap-4 border-b border-white/10 px-6" },
        h("div", { className: "min-w-0" },
          h("h1", { className: "text-[15px] font-bold tracking-tight text-slate-100" }, ptitle),
          h("p", { className: "truncate text-[11.5px] text-slate-500" }, psub),
        ),
        h("div", { className: "flex shrink-0 items-center gap-2" },
          ftotal > 0
            ? h("button", {
                className: "chip hover:bg-white/10",
                onClick: () => { setFindingSev(null); setTab("findings"); },
                title: "open findings",
              },
              h("span", { className: cx("sevdot", (SEV[p ? (fcountCrit(summary) ? "critical" : fcountHigh(summary) ? "high" : "medium") : "info"] ?? SEV.info).dot) }),
              h("span", { className: "font-mono" }, p.grade),
              h("span", { className: "text-slate-500" }, ftotal, " findings"),
            )
            : h("span", { className: "chip text-emerald-300" }, "clean"),
          h("button", { className: "btn shrink-0", onClick: () => setTab("scans") }, h(Icon, { name: "play", className: "h-3.5 w-3.5" }), h("span", { className: "hidden sm:inline" }, "Run scan")),
        ),
      ),
      h("main", { className: "min-h-0 flex-1" },
        pane("summary", h(Summary, { summary, findingsData: findings, jobs, go })),
        pane("diagram",
          h("div", { className: "flex h-full min-h-0 flex-col" },
            h("div", { className: "flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2" },
              h("div", { className: "flex items-center gap-1 rounded-lg border border-white/10 p-0.5" },
                DIAGRAM_VIEWS.map((v) =>
                  h("button", {
                    key: v,
                    className: cx("toggle border-0", diagView === v ? "toggle-on" : "toggle-off"),
                    onClick: () => setDiagView(v),
                    title: VIEW_HINT[v],
                  }, VIEW_LABEL[v])
                ),
              ),
              h("button", { className: cx("toggle", showFindings ? "toggle-on" : "toggle-off"), onClick: toggleFindings },
                h(Icon, { name: "alert", className: "h-3.5 w-3.5" }), "findings"),
              h("button", { className: cx("toggle", showDiffOv ? "toggle-on" : "toggle-off"), onClick: toggleDiffOv },
                h(Icon, { name: "drift", className: "h-3.5 w-3.5" }), "drift"),
              showDiffOv
                ? h(Fragment, null,
                    h("select", { className: "select font-mono text-[11px]", value: dfrom, onChange: onDFrom },
                      snaps.map((s) => h("option", { key: s.id, value: s.id }, s.id))),
                    h("span", { className: "text-slate-500" }, "\u2192"),
                    h("select", { className: "select font-mono text-[11px]", value: dto, onChange: onDTo },
                      snaps.map((s) => h("option", { key: s.id, value: s.id }, s.id))),
                    diffOv
                      ? h("span", { className: "ml-1 font-mono text-[11px] text-slate-500" },
                          h("span", { className: "text-emerald-400" }, `+${diffOv.counts.nodes_added}`),
                          " ",
                          h("span", { className: "text-red-400" }, `\u2212${diffOv.counts.nodes_removed}`),
                          " ",
                          h("span", { className: "text-amber-300" }, `~${diffOv.counts.nodes_changed}`),
                        )
                      : null,
                  )
                : null,
              // Only the two laid-out views have something worth exporting; the
              // flow view is a dependency graph, not a document.
              (diagView !== "flow")
                ? h(Fragment, null,
                    h("button", {
                      className: "toggle toggle-off", disabled: Boolean(exportBusy),
                      onClick: () => runExport("svg"),
                      title: "Download this diagram as a standalone SVG",
                    }, h(Icon, { name: "download", className: "h-3.5 w-3.5" }), exportBusy === "svg" ? "\u2026" : ".svg"),
                    h("button", {
                      className: cx("toggle", exportBusy === "all" ? "toggle-on" : "toggle-off"),
                      disabled: Boolean(exportBusy),
                      onClick: () => runExport("all"),
                      title: "Download one offline report with every diagram, the findings and the drift",
                    }, h(Icon, { name: "download", className: "h-3.5 w-3.5" }), exportBusy === "all" ? "building\u2026" : "export all"),
                    h("span", { className: "mx-0.5 h-5 w-px bg-white/10" }),
                    h("button", {
                      className: "toggle toggle-off", disabled: Boolean(exportBusy),
                      onClick: () => runExport("mmd"),
                      title: "Download Mermaid source — renders in GitHub and Confluence, diffs in git, editable afterwards",
                    }, h(Icon, { name: "download", className: "h-3.5 w-3.5" }), exportBusy === "mmd" ? "\u2026" : ".mmd"),
                    h("button", {
                      className: "toggle toggle-off", disabled: Boolean(exportBusy),
                      onClick: () => runExport("html"),
                      title: "Download a self-contained HTML report — diagram, findings and drift, in one offline file",
                    }, h(Icon, { name: "download", className: "h-3.5 w-3.5" }), exportBusy === "html" ? "\u2026" : ".html"),
                  )
                : null,
            ),
            h("div", { className: "min-h-0 flex-1" },
              h(Diagram, {
                graph,
                findingsGraph: showFindings ? findingGraph : null,
                diffOverlay: showDiffOv ? diffOv : null,
                view: diagView,
                region: (summary?.regions ?? [])[0],
                findings: findings?.findings ?? [],
                ensureDrift,
                exportRef,
              })),
          ),
        ),
        pane("findings", h(Findings, { data: findings, sev: findingSev, setSev: setFindingSev, onAsk: askAbout })),
        pane("scans", h(Scans, { jobs, connected: wsOk, run, act, scannedRegions: (summary?.regions ?? []).join(",") })),
        pane("ask", h(Ask, {
          log: askLog, busy: askBusy, onSend: askSend,
          provider: askProvider, setProvider: setAskProvider, lastAsst,
          oc, ocBusy, ocRun,
          prefill: askPrefill, onConsumePrefill: () => setAskPrefill(null),
        })),
        pane("diff", h(Diff)),
      ),
    ),
  );
}

function fcountCrit(s) { return s?.findings?.bySeverity?.critical > 0; }
function fcountHigh(s) { return s?.findings?.bySeverity?.high > 0; }

createRoot(document.getElementById("root")).render(h(App));
