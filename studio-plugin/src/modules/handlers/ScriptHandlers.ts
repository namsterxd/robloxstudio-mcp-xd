import Utils from "../Utils";
import Recording from "../Recording";

const ScriptEditorService = game.GetService("ScriptEditorService");

const { getInstancePath, getInstanceByPath, readScriptSource, splitLines, joinLines } = Utils;
const { beginRecording, finishRecording } = Recording;

function normalizeEscapes(s: string): string {
	let result = s;
	result = result.gsub("\\n", "\n")[0];
	result = result.gsub("\\t", "\t")[0];
	result = result.gsub("\\r", "\r")[0];
	result = result.gsub("\\\\", "\\")[0];
	return result;
}

function getScriptSource(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const startLine = requestData.startLine as number | undefined;
	const endLine = requestData.endLine as number | undefined;

	if (!instancePath) return { error: "Instance path is required" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const [success, result] = pcall(() => {
		const fullSource = readScriptSource(instance);
		const [lines, hasTrailingNewline] = splitLines(fullSource);
		const totalLineCount = lines.size();

		let sourceToReturn = fullSource;
		let returnedStartLine = 1;
		let returnedEndLine = totalLineCount;

		if (startLine !== undefined || endLine !== undefined) {
			const actualStartLine = math.max(1, startLine ?? 1);
			const actualEndLine = math.min(lines.size(), endLine ?? lines.size());

			const selectedLines: string[] = [];
			for (let i = actualStartLine; i <= actualEndLine; i++) {
				selectedLines.push(lines[i - 1] ?? "");
			}

			sourceToReturn = selectedLines.join("\n");
			if (hasTrailingNewline && actualEndLine === lines.size() && sourceToReturn.sub(-1) !== "\n") {
				sourceToReturn += "\n";
			}
			returnedStartLine = actualStartLine;
			returnedEndLine = actualEndLine;
		}

		const numberedLines: string[] = [];
		const linesToNumber = startLine !== undefined ? splitLines(sourceToReturn)[0] : lines;
		const lineOffset = returnedStartLine - 1;
		for (let i = 0; i < linesToNumber.size(); i++) {
			numberedLines.push(`${i + 1 + lineOffset}: ${linesToNumber[i]}`);
		}
		const numberedSource = numberedLines.join("\n");

		const resp: Record<string, unknown> = {
			instancePath,
			className: instance.ClassName,
			name: instance.Name,
			source: sourceToReturn,
			numberedSource,
			sourceLength: fullSource.size(),
			lineCount: totalLineCount,
			startLine: returnedStartLine,
			endLine: returnedEndLine,
			isPartial: startLine !== undefined || endLine !== undefined,
			truncated: false,
		};

		if (startLine === undefined && endLine === undefined && fullSource.size() > 50000) {
			const truncatedLines: string[] = [];
			const truncatedNumberedLines: string[] = [];
			const maxLines = math.min(1000, lines.size());
			for (let i = 0; i < maxLines; i++) {
				truncatedLines.push(lines[i]);
				truncatedNumberedLines.push(`${i + 1}: ${lines[i]}`);
			}
			resp.source = truncatedLines.join("\n");
			resp.numberedSource = truncatedNumberedLines.join("\n");
			resp.truncated = true;
			resp.endLine = maxLines;
			resp.note = "Script truncated to first 1000 lines. Use startLine/endLine parameters to read specific sections.";
		}

		if (instance.IsA("BaseScript")) {
			resp.enabled = instance.Enabled;
		}
		return resp;
	});

	if (success) {
		return result;
	} else {
		return { error: `Failed to get script source: ${result}` };
	}
}

function setScriptSource(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const newSource = requestData.source as string;

	if (!instancePath || !newSource) return { error: "Instance path and source are required" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const sourceToSet = normalizeEscapes(newSource);
	const recordingId = beginRecording(`Set script source: ${instance.Name}`);

	const [updateSuccess, updateResult] = pcall(() => {
		const oldSourceLength = readScriptSource(instance).size();

		ScriptEditorService.UpdateSourceAsync(instance, () => sourceToSet);

		return {
			success: true, instancePath,
			oldSourceLength, newSourceLength: sourceToSet.size(),
			method: "UpdateSourceAsync",
			message: "Script source updated successfully (editor-safe)",
		};
	});

	if (updateSuccess) {
		finishRecording(recordingId, true);
		return updateResult;
	}

	const [directSuccess, directResult] = pcall(() => {
		const oldSource = (instance as unknown as { Source: string }).Source;
		(instance as unknown as { Source: string }).Source = sourceToSet;

		return {
			success: true, instancePath,
			oldSourceLength: oldSource.size(), newSourceLength: sourceToSet.size(),
			method: "direct",
			message: "Script source updated successfully (direct assignment)",
		};
	});

	if (directSuccess) {
		finishRecording(recordingId, true);
		return directResult;
	}

	const [replaceSuccess, replaceResult] = pcall(() => {
		const parent = instance.Parent;
		const name = instance.Name;
		const className = instance.ClassName;
		const wasBaseScript = instance.IsA("BaseScript");
		const enabled = wasBaseScript ? instance.Enabled : undefined;

		const newScript = new Instance(className as keyof CreatableInstances) as LuaSourceContainer;
		newScript.Name = name;
		(newScript as unknown as { Source: string }).Source = sourceToSet;
		if (wasBaseScript && enabled !== undefined) {
			(newScript as BaseScript).Enabled = enabled;
		}

		newScript.Parent = parent;
		instance.Destroy();

		return {
			success: true,
			instancePath: getInstancePath(newScript),
			method: "replace",
			message: "Script replaced successfully with new source",
		};
	});

	if (replaceSuccess) {
		finishRecording(recordingId, true);
		return replaceResult;
	}

	finishRecording(recordingId, false);
	return {
		error: `Failed to set script source. UpdateSourceAsync failed: ${updateResult}. Direct assignment failed: ${directResult}. Replace method failed: ${replaceResult}`,
	};
}

function editScriptLines(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const startLine = requestData.startLine as number;
	const endLine = requestData.endLine as number;
	let newContent = requestData.newContent as string;

	if (!instancePath || !startLine || !endLine || !newContent) {
		return { error: "Instance path, startLine, endLine, and newContent are required" };
	}

	newContent = normalizeEscapes(newContent);

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const recordingId = beginRecording(`Edit script lines ${startLine}-${endLine}: ${instance.Name}`);

	const [success, result] = pcall(() => {
		const [lines, hadTrailingNewline] = splitLines(readScriptSource(instance));
		const totalLines = lines.size();

		if (startLine < 1 || startLine > totalLines) error(`startLine out of range (1-${totalLines})`);
		if (endLine < startLine || endLine > totalLines) error(`endLine out of range (${startLine}-${totalLines})`);

		const [newLines] = splitLines(newContent);
		const resultLines: string[] = [];

		for (let i = 0; i < startLine - 1; i++) resultLines.push(lines[i]);
		for (const line of newLines) resultLines.push(line);
		for (let i = endLine; i < totalLines; i++) resultLines.push(lines[i]);

		const newSource = joinLines(resultLines, hadTrailingNewline);
		ScriptEditorService.UpdateSourceAsync(instance, () => newSource);

		return {
			success: true, instancePath,
			editedLines: { startLine, endLine },
			linesRemoved: endLine - startLine + 1,
			linesAdded: newLines.size(),
			newLineCount: resultLines.size(),
			message: "Script lines edited successfully",
		};
	});

	if (success) {
		finishRecording(recordingId, true);
		return result;
	}
	finishRecording(recordingId, false);
	return { error: `Failed to edit script lines: ${result}` };
}

function insertScriptLines(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const afterLine = (requestData.afterLine as number) ?? 0;
	let newContent = requestData.newContent as string;

	if (!instancePath || !newContent) return { error: "Instance path and newContent are required" };

	newContent = normalizeEscapes(newContent);

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const recordingId = beginRecording(`Insert script lines after line ${afterLine}: ${instance.Name}`);

	const [success, result] = pcall(() => {
		const [lines, hadTrailingNewline] = splitLines(readScriptSource(instance));
		const totalLines = lines.size();

		if (afterLine < 0 || afterLine > totalLines) error(`afterLine out of range (0-${totalLines})`);

		const [newLines] = splitLines(newContent);
		const resultLines: string[] = [];

		for (let i = 0; i < afterLine; i++) resultLines.push(lines[i]);
		for (const line of newLines) resultLines.push(line);
		for (let i = afterLine; i < totalLines; i++) resultLines.push(lines[i]);

		const newSource = joinLines(resultLines, hadTrailingNewline);
		ScriptEditorService.UpdateSourceAsync(instance, () => newSource);

		return {
			success: true, instancePath,
			insertedAfterLine: afterLine,
			linesInserted: newLines.size(),
			newLineCount: resultLines.size(),
			message: "Script lines inserted successfully",
		};
	});

	if (success) {
		finishRecording(recordingId, true);
		return result;
	}
	finishRecording(recordingId, false);
	return { error: `Failed to insert script lines: ${result}` };
}

function deleteScriptLines(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const startLine = requestData.startLine as number;
	const endLine = requestData.endLine as number;

	if (!instancePath || !startLine || !endLine) {
		return { error: "Instance path, startLine, and endLine are required" };
	}

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const recordingId = beginRecording(`Delete script lines ${startLine}-${endLine}: ${instance.Name}`);

	const [success, result] = pcall(() => {
		const [lines, hadTrailingNewline] = splitLines(readScriptSource(instance));
		const totalLines = lines.size();

		if (startLine < 1 || startLine > totalLines) error(`startLine out of range (1-${totalLines})`);
		if (endLine < startLine || endLine > totalLines) error(`endLine out of range (${startLine}-${totalLines})`);

		const resultLines: string[] = [];
		for (let i = 0; i < startLine - 1; i++) resultLines.push(lines[i]);
		for (let i = endLine; i < totalLines; i++) resultLines.push(lines[i]);

		const newSource = joinLines(resultLines, hadTrailingNewline);
		ScriptEditorService.UpdateSourceAsync(instance, () => newSource);

		return {
			success: true, instancePath,
			deletedLines: { startLine, endLine },
			linesDeleted: endLine - startLine + 1,
			newLineCount: resultLines.size(),
			message: "Script lines deleted successfully",
		};
	});

	if (success) {
		finishRecording(recordingId, true);
		return result;
	}
	finishRecording(recordingId, false);
	return { error: `Failed to delete script lines: ${result}` };
}

type PatchOperation = "replace" | "insert" | "delete" | "set";

function applyPatchEditToSource(source: string, edit: Record<string, unknown>) {
	const operation = ((edit.operation as string) ?? "replace") as PatchOperation;

	if (operation === "set") {
		const nextSource = edit.source as string;
		if (nextSource === undefined) {
			error("set operation requires source");
		}

		const normalizedSource = normalizeEscapes(nextSource);
		return {
			source: normalizedSource,
			summary: {
				operation,
				newSourceLength: normalizedSource.size(),
			},
		};
	}

	const [lines, hadTrailingNewline] = splitLines(source);
	const totalLines = lines.size();

	if (operation === "replace") {
		const startLine = edit.startLine as number;
		const endLine = edit.endLine as number;
		const newContentRaw = edit.newContent as string;
		if (!startLine || !endLine || newContentRaw === undefined) {
			error("replace operation requires startLine, endLine, and newContent");
		}
		if (startLine < 1 || startLine > totalLines) {
			error(`startLine out of range (1-${totalLines})`);
		}
		if (endLine < startLine || endLine > totalLines) {
			error(`endLine out of range (${startLine}-${totalLines})`);
		}

		const [newLines] = splitLines(normalizeEscapes(newContentRaw));
		const resultLines: string[] = [];

		for (let i = 0; i < startLine - 1; i++) resultLines.push(lines[i]);
		for (const line of newLines) resultLines.push(line);
		for (let i = endLine; i < totalLines; i++) resultLines.push(lines[i]);

		const updatedSource = joinLines(resultLines, hadTrailingNewline);
		return {
			source: updatedSource,
			summary: {
				operation,
				startLine,
				endLine,
				linesRemoved: endLine - startLine + 1,
				linesAdded: newLines.size(),
			},
		};
	}

	if (operation === "insert") {
		const afterLine = (edit.afterLine as number) ?? 0;
		const newContentRaw = edit.newContent as string;
		if (newContentRaw === undefined) {
			error("insert operation requires newContent");
		}
		if (afterLine < 0 || afterLine > totalLines) {
			error(`afterLine out of range (0-${totalLines})`);
		}

		const [newLines] = splitLines(normalizeEscapes(newContentRaw));
		const resultLines: string[] = [];

		for (let i = 0; i < afterLine; i++) resultLines.push(lines[i]);
		for (const line of newLines) resultLines.push(line);
		for (let i = afterLine; i < totalLines; i++) resultLines.push(lines[i]);

		const updatedSource = joinLines(resultLines, hadTrailingNewline);
		return {
			source: updatedSource,
			summary: {
				operation,
				afterLine,
				linesAdded: newLines.size(),
			},
		};
	}

	if (operation === "delete") {
		const startLine = edit.startLine as number;
		const endLine = edit.endLine as number;
		if (!startLine || !endLine) {
			error("delete operation requires startLine and endLine");
		}
		if (startLine < 1 || startLine > totalLines) {
			error(`startLine out of range (1-${totalLines})`);
		}
		if (endLine < startLine || endLine > totalLines) {
			error(`endLine out of range (${startLine}-${totalLines})`);
		}

		const resultLines: string[] = [];
		for (let i = 0; i < startLine - 1; i++) resultLines.push(lines[i]);
		for (let i = endLine; i < totalLines; i++) resultLines.push(lines[i]);

		const updatedSource = joinLines(resultLines, hadTrailingNewline);
		return {
			source: updatedSource,
			summary: {
				operation,
				startLine,
				endLine,
				linesDeleted: endLine - startLine + 1,
			},
		};
	}

	error(`Unsupported operation: ${operation}`);
}

function applyPatchBatch(requestData: Record<string, unknown>) {
	const edits = requestData.edits as Record<string, unknown>[];
	const dryRun = (requestData.dryRun as boolean) ?? false;

	if (!edits || !typeIs(edits, "table") || (edits as defined[]).size() === 0) {
		return { error: "edits array is required" };
	}

	const scriptStates = new Map<string, {
		instance: LuaSourceContainer;
		originalSource: string;
		workingSource: string;
	}>();
	const editResults: Record<string, unknown>[] = [];

	for (let i = 0; i < edits.size(); i++) {
		const edit = edits[i];
		const instancePath = edit.instancePath as string;
		if (!instancePath) {
			return { error: `Edit ${i + 1} is missing instancePath`, failedEditIndex: i + 1 };
		}

		let state = scriptStates.get(instancePath);
		if (!state) {
			const instance = getInstanceByPath(instancePath);
			if (!instance) {
				return { error: `Instance not found: ${instancePath}`, failedEditIndex: i + 1 };
			}
			if (!instance.IsA("LuaSourceContainer")) {
				return {
					error: `Instance is not a script-like object: ${instance.ClassName}`,
					failedEditIndex: i + 1,
				};
			}

			const originalSource = readScriptSource(instance);
			state = {
				instance,
				originalSource,
				workingSource: originalSource,
			};
			scriptStates.set(instancePath, state);
		}

		const [ok, result] = pcall(() => {
			const applyResult = applyPatchEditToSource(state!.workingSource, edit) as {
				source: string;
				summary: Record<string, unknown>;
			};
			state!.workingSource = applyResult.source;
			return applyResult;
		});

		if (!ok) {
			return {
				error: `Edit ${i + 1} failed: ${result}`,
				failedEditIndex: i + 1,
				instancePath,
			};
		}

		const op = ((edit.operation as string) ?? "replace") as PatchOperation;
		const typedResult = result as { source: string; summary: Record<string, unknown> };
		editResults.push({
			index: i + 1,
			instancePath,
			operation: op,
			newSourceLength: typedResult.source.size(),
			...typedResult.summary,
		});
	}

	if (dryRun) {
		return {
			success: true,
			dryRun: true,
			edits: editResults,
			summary: {
				totalEdits: edits.size(),
				scriptsAffected: scriptStates.size(),
			},
		};
	}

	const recordingId = beginRecording(`Apply patch batch (${edits.size()} edits)`);
	const appliedPaths: string[] = [];

	for (const [instancePath, state] of scriptStates) {
		const [ok, err] = pcall(() => {
			ScriptEditorService.UpdateSourceAsync(state.instance, () => state.workingSource);
		});

		if (!ok) {
			const rollbackFailures: Record<string, unknown>[] = [];
			for (const path of appliedPaths) {
				const rollbackState = scriptStates.get(path);
				if (!rollbackState) continue;

				const [rollbackOk, rollbackErr] = pcall(() => {
					ScriptEditorService.UpdateSourceAsync(rollbackState.instance, () => rollbackState.originalSource);
				});

				if (!rollbackOk) {
					rollbackFailures.push({ path, error: tostring(rollbackErr) });
				}
			}

			finishRecording(recordingId, false);
			return {
				error: `Failed to apply patch on ${instancePath}: ${err}`,
				rolledBack: true,
				rollbackFailures,
			};
		}

		appliedPaths.push(instancePath);
	}

	finishRecording(recordingId, true);
	return {
		success: true,
		dryRun: false,
		edits: editResults,
		summary: {
			totalEdits: edits.size(),
			scriptsAffected: scriptStates.size(),
		},
	};
}

function isSymbolChar(ch: string | undefined): boolean {
	if (ch === undefined || ch === "") return false;
	if (ch === "_") return true;
	const [start] = string.find(ch, "[A-Za-z0-9]", 1);
	return start !== undefined;
}

function replaceSymbolInLine(
	line: string,
	oldName: string,
	newName: string,
	caseSensitive: boolean,
	exactWord: boolean,
) {
	const needle = caseSensitive ? oldName : oldName.lower();
	const haystack = caseSensitive ? line : line.lower();

	let searchFrom = 1;
	let rebuilt = "";
	let replacementCount = 0;
	const columns: number[] = [];

	while (true) {
		const [startCol, endCol] = string.find(haystack, needle, searchFrom, true);
		if (startCol === undefined || endCol === undefined) break;

		rebuilt += line.sub(searchFrom, startCol - 1);

		let valid = true;
		if (exactWord) {
			const before = startCol > 1 ? line.sub(startCol - 1, startCol - 1) : undefined;
			const after = endCol < line.size() ? line.sub(endCol + 1, endCol + 1) : undefined;
			valid = !isSymbolChar(before) && !isSymbolChar(after);
		}

		if (valid) {
			rebuilt += newName;
			replacementCount++;
			columns.push(startCol);
		} else {
			rebuilt += line.sub(startCol, endCol);
		}

		searchFrom = endCol + 1;
	}

	if (searchFrom <= line.size()) {
		rebuilt += line.sub(searchFrom);
	}

	return {
		line: rebuilt,
		replacementCount,
		columns,
	};
}

function replaceSymbolInSource(
	source: string,
	oldName: string,
	newName: string,
	caseSensitive: boolean,
	exactWord: boolean,
) {
	const [lines, hadTrailingNewline] = splitLines(source);
	const outputLines: string[] = [];
	const changedLines: Record<string, unknown>[] = [];
	let totalReplacements = 0;

	for (let i = 0; i < lines.size(); i++) {
		const line = lines[i];
		const replaced = replaceSymbolInLine(line, oldName, newName, caseSensitive, exactWord);
		outputLines.push(replaced.line);

		if (replaced.replacementCount > 0) {
			totalReplacements += replaced.replacementCount;
			changedLines.push({
				line: i + 1,
				replacements: replaced.replacementCount,
				columns: replaced.columns,
				before: line,
				after: replaced.line,
			});
		}
	}

	return {
		source: joinLines(outputLines, hadTrailingNewline),
		totalReplacements,
		changedLines,
	};
}

function renameSymbol(requestData: Record<string, unknown>) {
	const oldName = requestData.oldName as string;
	const newName = requestData.newName as string;
	if (!oldName || !newName) {
		return { error: "oldName and newName are required" };
	}
	if (oldName === newName) {
		return { error: "oldName and newName must be different" };
	}

	const startPath = (requestData.path as string) ?? "";
	const classFilter = requestData.classFilter as string | undefined;
	const caseSensitive = (requestData.caseSensitive as boolean) ?? true;
	const exactWord = (requestData.exactWord as boolean) ?? true;
	const dryRun = (requestData.dryRun as boolean) ?? true;
	const maxResults = math.max(1, (requestData.maxResults as number) ?? 2000);

	const startInstance = startPath !== "" ? getInstanceByPath(startPath) : game;
	if (!startInstance) return { error: `Path not found: ${startPath}` };

	const updates: Array<{
		instance: LuaSourceContainer;
		instancePath: string;
		originalSource: string;
		updatedSource: string;
		replacementCount: number;
		changedLines: Record<string, unknown>[];
	}> = [];

	let scriptsSearched = 0;
	let scriptsChanged = 0;
	let totalReplacements = 0;
	let truncated = false;

	function walk(instance: Instance) {
		if (truncated) return;

		if (instance.IsA("LuaSourceContainer")) {
			if (classFilter && !instance.ClassName.lower().find(classFilter.lower())[0]) {
				return;
			}

			scriptsSearched++;
			const originalSource = readScriptSource(instance);
			const replaced = replaceSymbolInSource(originalSource, oldName, newName, caseSensitive, exactWord);

			if (replaced.totalReplacements > 0) {
				if (totalReplacements + replaced.totalReplacements > maxResults) {
					truncated = true;
					return;
				}

				totalReplacements += replaced.totalReplacements;
				scriptsChanged++;
				updates.push({
					instance,
					instancePath: getInstancePath(instance),
					originalSource,
					updatedSource: replaced.source,
					replacementCount: replaced.totalReplacements,
					changedLines: replaced.changedLines,
				});
			}
		}

		for (const child of instance.GetChildren()) {
			walk(child);
			if (truncated) return;
		}
	}

	walk(startInstance);

	if (truncated) {
		return {
			error: `Rename scan exceeded maxResults (${maxResults}). Increase maxResults or narrow the path.`,
			dryRun: true,
			oldName,
			newName,
			scriptsSearched,
			scriptsChanged,
			totalReplacements,
		};
	}

	if (dryRun) {
		return {
			success: true,
			dryRun: true,
			oldName,
			newName,
			summary: {
				scriptsSearched,
				scriptsChanged,
				totalReplacements,
			},
			changes: updates.map((u) => ({
				instancePath: u.instancePath,
				replacementCount: u.replacementCount,
				changedLines: u.changedLines,
			})),
		};
	}

	const recordingId = beginRecording(`Rename symbol ${oldName} -> ${newName}`);
	const appliedUpdates: typeof updates = [];

	for (const update of updates) {
		const [ok, err] = pcall(() => {
			ScriptEditorService.UpdateSourceAsync(update.instance, () => update.updatedSource);
		});

		if (!ok) {
			const rollbackFailures: Record<string, unknown>[] = [];
			for (const applied of appliedUpdates) {
				const [rollbackOk, rollbackErr] = pcall(() => {
					ScriptEditorService.UpdateSourceAsync(applied.instance, () => applied.originalSource);
				});
				if (!rollbackOk) {
					rollbackFailures.push({
						instancePath: applied.instancePath,
						error: tostring(rollbackErr),
					});
				}
			}

			finishRecording(recordingId, false);
			return {
				error: `Failed to rename in ${update.instancePath}: ${err}`,
				rolledBack: true,
				rollbackFailures,
			};
		}

		appliedUpdates.push(update);
	}

	finishRecording(recordingId, true);
	return {
		success: true,
		dryRun: false,
		oldName,
		newName,
		summary: {
			scriptsSearched,
			scriptsChanged,
			totalReplacements,
		},
		changes: updates.map((u) => ({
			instancePath: u.instancePath,
			replacementCount: u.replacementCount,
			changedLines: u.changedLines,
		})),
	};
}

export = {
	getScriptSource,
	setScriptSource,
	editScriptLines,
	insertScriptLines,
	deleteScriptLines,
	applyPatchBatch,
	renameSymbol,
};
