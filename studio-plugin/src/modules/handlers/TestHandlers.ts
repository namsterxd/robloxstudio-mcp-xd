import { LogService } from "@rbxts/services";
import Utils from "../Utils";

const StudioTestService = game.GetService("StudioTestService");
const ServerScriptService = game.GetService("ServerScriptService");
const ScriptEditorService = game.GetService("ScriptEditorService");
const { getInstancePath, getInstanceByPath, readScriptSource, splitLines } = Utils;

const STOP_SIGNAL = "__MCP_STOP__";

interface OutputEntry {
	message: string;
	messageType: string;
	timestamp: number;
}

let testRunning = false;
let outputBuffer: OutputEntry[] = [];
let logConnection: RBXScriptConnection | undefined;
let testResult: unknown;
let testError: string | undefined;
let stopListenerScript: Script | undefined;

interface BufferedLogEntry {
	id: number;
	message: string;
	messageType: string;
	timestamp: number;
}

const LOG_RING_CAPACITY = 2000;
let bufferedLogs: BufferedLogEntry[] = [];
let nextLogId = 1;
let globalLogConnection: RBXScriptConnection | undefined;

function addBufferedLog(message: string, messageType: string) {
	const entry: BufferedLogEntry = {
		id: nextLogId,
		message,
		messageType,
		timestamp: tick(),
	};
	nextLogId++;

	bufferedLogs.push(entry);
	while (bufferedLogs.size() > LOG_RING_CAPACITY) {
		bufferedLogs.shift();
	}
}

function ensureGlobalLogCapture() {
	if (globalLogConnection) return;

	globalLogConnection = LogService.MessageOut.Connect((message, messageType) => {
		if (message === STOP_SIGNAL) return;
		addBufferedLog(message, messageType.Name);
	});
}

function buildStopListenerSource(): string {
	return `local LogService = game:GetService("LogService")
local StudioTestService = game:GetService("StudioTestService")
LogService.MessageOut:Connect(function(message)
	if message == "${STOP_SIGNAL}" then
		pcall(function() StudioTestService:EndTest("stopped_by_mcp") end)
	end
end)`;
}

function injectStopListener() {
	const listener = new Instance("Script");
	listener.Name = "__MCP_StopListener";
	listener.Parent = ServerScriptService;

	const source = buildStopListenerSource();
	const [seOk] = pcall(() => {
		ScriptEditorService.UpdateSourceAsync(listener, () => source);
	});
	if (!seOk) {
		(listener as unknown as { Source: string }).Source = source;
	}

	stopListenerScript = listener;
}

function cleanupStopListener() {
	if (stopListenerScript) {
		pcall(() => stopListenerScript!.Destroy());
		stopListenerScript = undefined;
	}
}

function startPlaytest(requestData: Record<string, unknown>) {
	const mode = requestData.mode as string | undefined;

	if (mode !== "play" && mode !== "run") {
		return { error: 'mode must be "play" or "run"' };
	}

	if (testRunning) {
		return { error: "A test is already running" };
	}

	testRunning = true;
	outputBuffer = [];
	testResult = undefined;
	testError = undefined;
	ensureGlobalLogCapture();

	cleanupStopListener();

	logConnection = LogService.MessageOut.Connect((message, messageType) => {
		if (message === STOP_SIGNAL) return;
		outputBuffer.push({
			message,
			messageType: messageType.Name,
			timestamp: tick(),
		});
	});

	const [injected, injErr] = pcall(() => injectStopListener());
	if (!injected) {
		warn(`[MCP] Failed to inject stop listener: ${injErr}`);
	}

	task.spawn(() => {
		const [ok, result] = pcall(() => {
			if (mode === "play") {
				return StudioTestService.ExecutePlayModeAsync({});
			}
			return StudioTestService.ExecuteRunModeAsync({});
		});

		if (ok) {
			testResult = result;
		} else {
			testError = tostring(result);
		}

		if (logConnection) {
			logConnection.Disconnect();
			logConnection = undefined;
		}
		testRunning = false;

		cleanupStopListener();
	});

	return { success: true, message: `Playtest started in ${mode} mode` };
}

function stopPlaytest(_requestData: Record<string, unknown>) {
	if (!testRunning) {
		return { error: "No test is currently running" };
	}

	warn(STOP_SIGNAL);

	return {
		success: true,
		output: [...outputBuffer],
		outputCount: outputBuffer.size(),
		message: "Playtest stop signal sent.",
	};
}

function getPlaytestOutput(_requestData: Record<string, unknown>) {
	return {
		isRunning: testRunning,
		output: [...outputBuffer],
		outputCount: outputBuffer.size(),
		testResult: testResult !== undefined ? tostring(testResult) : undefined,
		testError,
	};
}

function parseLineFromError(message: string): number | undefined {
	const [lineStr] = message.match(":(%d+):") as LuaTuple<[string?]>;
	if (!lineStr) return undefined;
	return tonumber(lineStr) ?? undefined;
}

function runTests(requestData: Record<string, unknown>) {
	const startPath = (requestData.path as string) ?? "";
	const includeWarnings = (requestData.includeWarnings as boolean) ?? true;
	const maxIssues = math.max(1, (requestData.maxIssues as number) ?? 200);

	const startInstance = startPath !== "" ? getInstanceByPath(startPath) : game;
	if (!startInstance) return { error: `Path not found: ${startPath}` };

	const issues: Record<string, unknown>[] = [];
	let scriptsChecked = 0;
	let syntaxErrors = 0;
	let warnings = 0;
	let truncated = false;

	const warningPatterns = [
		{ code: "DEPRECATED_WAIT", pattern: "wait(", message: "Use task.wait() instead of wait()" },
		{ code: "DEPRECATED_CONNECT", pattern: ":connect(", message: "Use :Connect() instead of :connect()" },
		{ code: "DEPRECATED_SPAWN", pattern: "spawn(", message: "Use task.spawn() instead of spawn()" },
	];

	function addIssue(issue: Record<string, unknown>) {
		if (issues.size() >= maxIssues) {
			truncated = true;
			return false;
		}
		issues.push(issue);
		return true;
	}

	function walk(instance: Instance) {
		if (truncated) return;

		if (instance.IsA("LuaSourceContainer")) {
			scriptsChecked++;
			const source = readScriptSource(instance);
			const instancePath = getInstancePath(instance);

			const [compileFn, compileError] = loadstring(source);
			if (!compileFn) {
				syntaxErrors++;
				if (!addIssue({
					severity: "error",
					code: "SYNTAX_ERROR",
					instancePath,
					line: parseLineFromError(tostring(compileError)),
					message: tostring(compileError),
				})) {
					return;
				}
			}

			if (includeWarnings) {
				const [lines] = splitLines(source);
				for (let i = 0; i < lines.size(); i++) {
					if (truncated) return;
					const line = lines[i].lower();

					for (const pattern of warningPatterns) {
						if (line.find((pattern.pattern as string).lower())[0] !== undefined) {
							warnings++;
							if (!addIssue({
								severity: "warning",
								code: pattern.code,
								instancePath,
								line: i + 1,
								message: pattern.message,
							})) {
								return;
							}
						}
					}
				}
			}
		}

		for (const child of instance.GetChildren()) {
			walk(child);
			if (truncated) return;
		}
	}

	walk(startInstance);

	return {
		success: true,
		passed: syntaxErrors === 0,
		truncated,
		summary: {
			scriptsChecked,
			syntaxErrors,
			warnings,
			issueCount: issues.size(),
		},
		issues,
		requestedPath: startPath,
	};
}

function runPlaytestChecks(requestData: Record<string, unknown>) {
	const mode = (requestData.mode as string) ?? "play";
	const durationSeconds = math.clamp((requestData.durationSeconds as number) ?? 10, 1, 120);
	const settleTimeoutSeconds = math.clamp((requestData.settleTimeoutSeconds as number) ?? 12, 1, 30);
	const maxIssues = math.max(1, (requestData.maxIssues as number) ?? 300);

	if (mode !== "play" && mode !== "run") {
		return { error: 'mode must be "play" or "run"' };
	}

	if (testRunning) {
		return { error: "A test is already running" };
	}

	ensureGlobalLogCapture();
	testRunning = true;
	testResult = undefined;
	testError = undefined;

	const localOutput: OutputEntry[] = [];
	const localConnection = LogService.MessageOut.Connect((message, messageType) => {
		if (message === STOP_SIGNAL) return;
		localOutput.push({
			message,
			messageType: messageType.Name,
			timestamp: tick(),
		});
	});

	cleanupStopListener();
	const [injectOk, injectErr] = pcall(() => injectStopListener());
	if (!injectOk) {
		warn(`[MCP] Failed to inject stop listener: ${injectErr}`);
	}

	let finished = false;
	let runError: string | undefined;

	task.spawn(() => {
		const [ok, result] = pcall(() => {
			if (mode === "play") {
				return StudioTestService.ExecutePlayModeAsync({});
			}
			return StudioTestService.ExecuteRunModeAsync({});
		});

		if (ok) {
			testResult = result;
		} else {
			runError = tostring(result);
			testError = runError;
		}

		finished = true;
	});

	const startedAt = tick();
	while ((tick() - startedAt) < durationSeconds && !finished) {
		task.wait(0.25);
	}

	let forcedStop = false;
	if (!finished) {
		forcedStop = true;
		warn(STOP_SIGNAL);
	}

	const settleStart = tick();
	while (!finished && (tick() - settleStart) < settleTimeoutSeconds) {
		task.wait(0.2);
	}

	const settleTimedOut = !finished;
	if (settleTimedOut && !runError) {
		runError = "Timed out waiting for playtest to stop";
		testError = runError;
	}

	localConnection.Disconnect();
	cleanupStopListener();
	testRunning = false;

	const issues: Record<string, unknown>[] = [];
	let warningCount = 0;
	let errorCount = 0;

	for (let i = 0; i < localOutput.size(); i++) {
		if (issues.size() >= maxIssues) break;

		const entry = localOutput[i];
		const lowerType = entry.messageType.lower();
		let severity: string | undefined;
		if (lowerType.find("error")[0] !== undefined) {
			severity = "error";
			errorCount++;
		} else if (lowerType.find("warning")[0] !== undefined) {
			severity = "warning";
			warningCount++;
		}

		if (severity) {
			issues.push({
				severity,
				messageType: entry.messageType,
				line: parseLineFromError(entry.message),
				message: entry.message,
				timestamp: entry.timestamp,
			});
		}
	}

	if (runError && issues.size() < maxIssues) {
		errorCount++;
		issues.push({
			severity: "error",
			code: "PLAYTEST_RUNTIME",
			message: runError,
		});
	}

	const pass = errorCount === 0 && !settleTimedOut;

	return {
		success: true,
		passed: pass,
		mode,
		durationSeconds,
		forcedStop,
		settleTimedOut,
		summary: {
			totalLogs: localOutput.size(),
			warningCount,
			errorCount,
			issueCount: issues.size(),
		},
		issues,
		testResult: testResult !== undefined ? tostring(testResult) : undefined,
		testError,
	};
}

function logsSince(requestData: Record<string, unknown>) {
	ensureGlobalLogCapture();

	const cursor = math.max(0, (requestData.cursor as number) ?? 0);
	const limit = math.clamp((requestData.limit as number) ?? 200, 1, 1000);

	const unseen: BufferedLogEntry[] = [];
	for (const entry of bufferedLogs) {
		if (entry.id > cursor) unseen.push(entry);
	}

	const limited: BufferedLogEntry[] = [];
	for (let i = 0; i < unseen.size() && i < limit; i++) {
		limited.push(unseen[i]);
	}

	const hasMore = unseen.size() > limited.size();
	const nextCursor = limited.size() > 0 ? limited[limited.size() - 1].id : cursor;

	return {
		cursor: nextCursor,
		previousCursor: cursor,
		hasMore,
		count: limited.size(),
		entries: limited.map((entry) => ({
			id: entry.id,
			message: entry.message,
			messageType: entry.messageType,
			timestamp: entry.timestamp,
		})),
	};
}

ensureGlobalLogCapture();

export = {
	startPlaytest,
	stopPlaytest,
	getPlaytestOutput,
	runTests,
	runPlaytestChecks,
	logsSince,
};
