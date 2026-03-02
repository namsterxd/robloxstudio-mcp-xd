import Utils from "../Utils";

const { getInstancePath, getInstanceByPath } = Utils;

interface SceneSnapshotEntry {
	path: string;
	name: string;
	className: string;
	parentPath?: string;
	depth: number;
	childCount: number;
	properties: Record<string, string>;
}

interface SceneSnapshot {
	id: string;
	createdAt: number;
	rootPath: string;
	maxDepth: number;
	nodeCount: number;
	truncated: boolean;
	entries: Record<string, SceneSnapshotEntry>;
}

const snapshots = new Map<string, SceneSnapshot>();
const snapshotOrder: string[] = [];
const MAX_STORED_SNAPSHOTS = 20;

function formatNumber(value: number): string {
	return tostring(math.round(value * 1000) / 1000);
}

function serializePropertyValue(value: unknown): string {
	const t = typeOf(value);
	if (t === "Vector3") {
		const v = value as Vector3;
		return `Vector3(${formatNumber(v.X)}, ${formatNumber(v.Y)}, ${formatNumber(v.Z)})`;
	}
	if (t === "Vector2") {
		const v = value as Vector2;
		return `Vector2(${formatNumber(v.X)}, ${formatNumber(v.Y)})`;
	}
	if (t === "UDim2") {
		const v = value as UDim2;
		return `UDim2(${formatNumber(v.X.Scale)}, ${v.X.Offset}, ${formatNumber(v.Y.Scale)}, ${v.Y.Offset})`;
	}
	if (t === "Color3") {
		const v = value as Color3;
		return `Color3(${formatNumber(v.R)}, ${formatNumber(v.G)}, ${formatNumber(v.B)})`;
	}
	if (t === "CFrame") {
		const v = value as CFrame;
		return `CFrame(${formatNumber(v.Position.X)}, ${formatNumber(v.Position.Y)}, ${formatNumber(v.Position.Z)})`;
	}
	if (t === "BrickColor") {
		return (value as BrickColor).Name;
	}
	if (t === "EnumItem") {
		const e = value as EnumItem;
		return `${e.EnumType}.${e.Name}`;
	}
	if (value === undefined) return "nil";
	return tostring(value);
}

function safeReadProperty(instance: Instance, propertyName: string): string | undefined {
	const [ok, value] = pcall(() => (instance as unknown as Record<string, unknown>)[propertyName]);
	if (!ok) return undefined;
	return serializePropertyValue(value);
}

function collectTrackedProperties(instance: Instance): Record<string, string> {
	const properties: Record<string, string> = {};

	const baseProps = ["Name"];
	for (const prop of baseProps) {
		const value = safeReadProperty(instance, prop);
		if (value !== undefined) properties[prop] = value;
	}

	if (instance.IsA("BasePart")) {
		const partProps = [
			"Anchored",
			"CanCollide",
			"Transparency",
			"Material",
			"BrickColor",
			"Position",
			"Size",
			"Orientation",
		];
		for (const prop of partProps) {
			const value = safeReadProperty(instance, prop);
			if (value !== undefined) properties[prop] = value;
		}
	}

	if (instance.IsA("GuiObject")) {
		const guiProps = ["Visible", "Active", "Position", "Size", "ZIndex"];
		for (const prop of guiProps) {
			const value = safeReadProperty(instance, prop);
			if (value !== undefined) properties[prop] = value;
		}

		if (instance.IsA("TextLabel") || instance.IsA("TextButton") || instance.IsA("TextBox")) {
			const textValue = safeReadProperty(instance, "Text");
			if (textValue !== undefined) properties.Text = textValue;
		}
	}

	if (instance.IsA("LuaSourceContainer")) {
		const enabledValue = safeReadProperty(instance, "Enabled");
		if (enabledValue !== undefined) properties.Enabled = enabledValue;
	}

	if (instance.IsA("ValueBase")) {
		const value = safeReadProperty(instance, "Value");
		if (value !== undefined) properties.Value = value;
	}

	return properties;
}

function saveSnapshot(snapshot: SceneSnapshot) {
	snapshots.set(snapshot.id, snapshot);
	snapshotOrder.push(snapshot.id);

	while (snapshotOrder.size() > MAX_STORED_SNAPSHOTS) {
		const oldest = snapshotOrder.shift();
		if (oldest) snapshots.delete(oldest);
	}
}

function snapshotScene(requestData: Record<string, unknown>) {
	const rootPath = (requestData.path as string) ?? "game.Workspace";
	const maxDepth = math.max(0, (requestData.maxDepth as number) ?? 4);
	const maxNodes = math.max(1, (requestData.maxNodes as number) ?? 3000);
	const includeProperties = (requestData.includeProperties as boolean) ?? true;
	const includeData = (requestData.includeData as boolean) ?? false;

	const rootInstance = getInstanceByPath(rootPath);
	if (!rootInstance) return { error: `Path not found: ${rootPath}` };

	const entries: Record<string, SceneSnapshotEntry> = {};
	let nodeCount = 0;
	let truncated = false;

	function walk(instance: Instance, depth: number, parentPath?: string) {
		if (truncated) return;
		if (nodeCount >= maxNodes) {
			truncated = true;
			return;
		}

		nodeCount++;
		const path = getInstancePath(instance);
		entries[path] = {
			path,
			name: instance.Name,
			className: instance.ClassName,
			parentPath,
			depth,
			childCount: instance.GetChildren().size(),
			properties: includeProperties ? collectTrackedProperties(instance) : {},
		};

		if (depth >= maxDepth) return;

		for (const child of instance.GetChildren()) {
			walk(child, depth + 1, path);
			if (truncated) return;
		}
	}

	walk(rootInstance, 0, undefined);

	const snapshotId =
		(requestData.snapshotId as string) ??
		`snapshot_${math.floor(tick() * 1000)}_${math.random(1000, 9999)}`;

	const snapshot: SceneSnapshot = {
		id: snapshotId,
		createdAt: tick(),
		rootPath,
		maxDepth,
		nodeCount,
		truncated,
		entries,
	};

	saveSnapshot(snapshot);

	return {
		success: true,
		snapshotId,
		createdAt: snapshot.createdAt,
		rootPath,
		maxDepth,
		nodeCount,
		truncated,
		includeProperties,
		data: includeData ? entries : undefined,
	};
}

function diffScene(requestData: Record<string, unknown>) {
	const fromSnapshotId = requestData.fromSnapshotId as string;
	const toSnapshotId = requestData.toSnapshotId as string;
	if (!fromSnapshotId || !toSnapshotId) {
		return { error: "fromSnapshotId and toSnapshotId are required" };
	}

	const fromSnapshot = snapshots.get(fromSnapshotId);
	const toSnapshot = snapshots.get(toSnapshotId);
	if (!fromSnapshot) return { error: `Snapshot not found: ${fromSnapshotId}` };
	if (!toSnapshot) return { error: `Snapshot not found: ${toSnapshotId}` };

	const maxChanges = math.max(1, (requestData.maxChanges as number) ?? 500);
	let detailCount = 0;
	let detailTruncated = false;

	const added: Record<string, unknown>[] = [];
	const removed: Record<string, unknown>[] = [];
	const changed: Record<string, unknown>[] = [];

	let addedCount = 0;
	let removedCount = 0;
	let changedCount = 0;

	function canAddDetail() {
		if (detailCount < maxChanges) {
			detailCount++;
			return true;
		}
		detailTruncated = true;
		return false;
	}

	for (const [path, toEntry] of pairs(toSnapshot.entries)) {
		const fromEntry = fromSnapshot.entries[path as string];
		if (!fromEntry) {
			addedCount++;
			if (canAddDetail()) {
				added.push({
					path: toEntry.path,
					name: toEntry.name,
					className: toEntry.className,
					parentPath: toEntry.parentPath,
				});
			}
			continue;
		}

		const propertyChanges: Record<string, { from?: string; to?: string }> = {};
		let hasChanges = false;

		if (fromEntry.className !== toEntry.className || fromEntry.name !== toEntry.name) {
			hasChanges = true;
		}

		const seenKeys = new Set<string>();
		for (const [key, value] of pairs(fromEntry.properties)) {
			seenKeys.add(key as string);
			if (toEntry.properties[key as string] !== value) {
				hasChanges = true;
				propertyChanges[key as string] = {
					from: value as string,
					to: toEntry.properties[key as string],
				};
			}
		}

		for (const [key, value] of pairs(toEntry.properties)) {
			if (seenKeys.has(key as string)) continue;
			hasChanges = true;
			propertyChanges[key as string] = {
				from: fromEntry.properties[key as string],
				to: value as string,
			};
		}

		if (hasChanges) {
			changedCount++;
			if (canAddDetail()) {
				changed.push({
					path: toEntry.path,
					fromClassName: fromEntry.className,
					toClassName: toEntry.className,
					fromName: fromEntry.name,
					toName: toEntry.name,
					propertyChanges,
				});
			}
		}
	}

	for (const [path, fromEntry] of pairs(fromSnapshot.entries)) {
		if (toSnapshot.entries[path as string]) continue;
		removedCount++;
		if (canAddDetail()) {
			removed.push({
				path: fromEntry.path,
				name: fromEntry.name,
				className: fromEntry.className,
				parentPath: fromEntry.parentPath,
			});
		}
	}

	return {
		success: true,
		fromSnapshotId,
		toSnapshotId,
		summary: {
			added: addedCount,
			removed: removedCount,
			changed: changedCount,
			detailCount,
			detailTruncated,
		},
		added,
		removed,
		changed,
	};
}

export = {
	snapshotScene,
	diffScene,
};
