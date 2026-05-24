import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let activePanel: vscode.WebviewPanel | undefined = undefined;

export async function activate(context: vscode.ExtensionContext) {
  // Python 확장 기능이 설치되어 있고 활성화되지 않았다면 명시적으로 활성화 대기
  try {
    const pythonExtension = vscode.extensions.getExtension('ms-python.python');
    if (pythonExtension && !pythonExtension.isActive) {
      await pythonExtension.activate();
    }
  } catch (err) {
    console.error('Python extension activation failed:', err);
  }

  // 1. 파일 전체 호출 그래프 보기 커맨드
  let viewGraphDisposable = vscode.commands.registerCommand(
    'python-callgraph.viewFileGraph',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('활성화된 에디터가 없습니다.');
        return;
      }
      
      const document = editor.document;
      if (document.languageId !== 'python') {
        vscode.window.showErrorMessage('Python 파일에서만 Call Graph를 생성할 수 있습니다.');
        return;
      }

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Call Graph 분석 중...",
        cancellable: false
      }, async (progress) => {
        try {
          const { nodes, edges } = await analyzeFileCallGraph(document);
          showWebview(context, document.fileName, nodes, edges);
        } catch (error: any) {
          vscode.window.showErrorMessage(`Call Graph 생성 실패: ${error.message}`);
        }
      });
    }
  );

  // 2. 특정 함수 기점 노드 추가 커맨드
  let addFunctionDisposable = vscode.commands.registerCommand(
    'python-callgraph.addFunctionToGraph',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('활성화된 에디터가 없습니다.');
        return;
      }

      const document = editor.document;
      const position = editor.selection.active;

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "함수 호출 구조 분석 중...",
        cancellable: false
      }, async (progress) => {
        try {
          // 커서 위치의 함수 분석
          const result = await analyzeFunctionAtPosition(document, position);
          if (!result) {
            vscode.window.showWarningMessage('커서 위치에서 유효한 함수 정보를 찾을 수 없습니다.');
            return;
          }

          if (activePanel) {
            // 이미 활성화된 웹뷰가 있으면 새 노드 및 엣지 정보 전달
            activePanel.webview.postMessage({
              type: 'addNodes',
              nodes: result.nodes,
              edges: result.edges
            });
            activePanel.reveal();
          } else {
            // 웹뷰가 없으면 새로 생성해서 분석한 특정 노드 기준으로 시각화
            showWebview(context, `${result.mainNodeName} 기준`, result.nodes, result.edges);
          }
        } catch (error: any) {
          vscode.window.showErrorMessage(`노드 추가 실패: ${error.message}`);
        }
      });
    }
  );

  context.subscriptions.push(viewGraphDisposable, addFunctionDisposable);
}

// 파일 및 클래스 그룹 노드를 노드 리스트에 동적으로 주입하는 헬퍼 함수
function injectGroupNodes(nodes: any[]) {
  const groupNodes: any[] = [];
  const childNodes: any[] = [];
  const addedGroups = new Set<string>();

  nodes.forEach(node => {
    // 1. 파일 그룹 노드 추가
    if (node.fileParentId && !addedGroups.has(node.fileParentId)) {
      addedGroups.add(node.fileParentId);
      groupNodes.push({
        id: node.fileParentId,
        label: node.fileName || 'Unknown File',
        isGroup: true,
        type: 'file'
      });
    }

    // 2. 클래스 그룹 노드 추가 (파일 그룹 하위에 중첩 배치)
    if (node.classParentId && !addedGroups.has(node.classParentId)) {
      addedGroups.add(node.classParentId);
      groupNodes.push({
        id: node.classParentId,
        label: `class ${node.className}`,
        parent: node.fileParentId,
        isGroup: true,
        type: 'class'
      });
    }

    // 3. 일반 함수 노드 추가
    childNodes.push(node);
  });

  // 부모 그룹 노드가 자식 노드보다 항상 배열 상 앞서 위치하도록 반환 (순서 버그 해결)
  return [...groupNodes, ...childNodes];
}

// 특정 위치의 함수와 그 함수가 호출하는 함수 분석
async function analyzeFunctionAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
) {
  // CallHierarchy 명령어 존재 여부 검사
  const commands = await vscode.commands.getCommands(true);
  const hasCallHierarchy = commands.includes('vscode.executePrepareCallHierarchy');

  if (!hasCallHierarchy) {
    console.log('Call Hierarchy API unavailable. Falling back to static function analysis.');
    const res = analyzeFunctionAtPositionStatic(document, position);
    return res ? { ...res, nodes: injectGroupNodes(res.nodes) } : null;
  }

  try {
    // CallHierarchy 준비
    const items: any[] = await vscode.commands.executeCommand(
      'vscode.executePrepareCallHierarchy',
      document.uri,
      position
    ) || [];

    if (!items || items.length === 0) {
      const res = analyzeFunctionAtPositionStatic(document, position);
      return res ? { ...res, nodes: injectGroupNodes(res.nodes) } : null;
    }

    const mainItem = items[0];
    const nodes: any[] = [];
    const edges: any[] = [];

    const mainNodeId = getItemId(mainItem);
    nodes.push(itemToNode(mainItem));

    // Outgoing Calls 분석
    const outgoingCalls: any[] = await vscode.commands.executeCommand(
      'vscode.provideOutgoingCalls',
      mainItem
    ) || [];

    for (const call of outgoingCalls) {
      const targetItem = call.to;
      const targetNodeId = getItemId(targetItem);

      // 노드가 중복되지 않도록 추가
      if (!nodes.some(n => n.id === targetNodeId)) {
        nodes.push(itemToNode(targetItem));
      }

      // 호출이 발생한 소스 내부의 구체적인 범위 정보 파싱
      const callRanges = call.fromRanges.map((r: vscode.Range) => ({
        startLine: r.start.line,
        startCharacter: r.start.character,
        endLine: r.end.line,
        endCharacter: r.end.character
      }));

      edges.push({
        id: `${mainNodeId}->${targetNodeId}`,
        source: mainNodeId,
        target: targetNodeId,
        callRanges
      });
    }

    return {
      mainNodeName: mainItem.name,
      nodes: injectGroupNodes(nodes),
      edges
    };
  } catch (err) {
    const res = analyzeFunctionAtPositionStatic(document, position);
    return res ? { ...res, nodes: injectGroupNodes(res.nodes) } : null;
  }
}

// 파일 내의 모든 함수와 그들의 호출 관계 분석
async function analyzeFileCallGraph(document: vscode.TextDocument) {
  // CallHierarchy 명령어 존재 여부 검사
  const commands = await vscode.commands.getCommands(true);
  const hasCallHierarchy = commands.includes('vscode.executePrepareCallHierarchy');

  if (!hasCallHierarchy) {
    console.log('Call Hierarchy API unavailable. Falling back to static file call graph analysis.');
    const res = analyzeFileCallGraphStatic(document);
    return { ...res, nodes: injectGroupNodes(res.nodes) };
  }

  try {
    const nodes: any[] = [];
    const edges: any[] = [];
    const nodeMap = new Map<string, any>();

    // 1. 파일 내의 모든 심볼 가져오기
    const symbols: vscode.DocumentSymbol[] = await vscode.commands.executeCommand(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    ) || [];

    // 재귀적으로 함수 심볼 수집
    const functionSymbols: vscode.DocumentSymbol[] = [];
    function collectFunctions(syms: vscode.DocumentSymbol[]) {
      for (const sym of syms) {
        if (
          sym.kind === vscode.SymbolKind.Function ||
          sym.kind === vscode.SymbolKind.Method ||
          sym.kind === vscode.SymbolKind.Constructor
        ) {
          functionSymbols.push(sym);
        }
        if (sym.children && sym.children.length > 0) {
          collectFunctions(sym.children);
        }
      }
    }
    collectFunctions(symbols);

    if (functionSymbols.length === 0) {
      // 심볼 조차 없다면 정적 분석 폴백 실행
      const res = analyzeFileCallGraphStatic(document);
      return { ...res, nodes: injectGroupNodes(res.nodes) };
    }

    // 2. 각 함수 기점에 대해 Call Hierarchy 정보 수집
    for (const sym of functionSymbols) {
      const startPos = sym.selectionRange.start;
      const items: vscode.CallHierarchyItem[] = await vscode.commands.executeCommand(
        'vscode.executePrepareCallHierarchy',
        document.uri,
        startPos
      ) || [];

      if (items && items.length > 0) {
        const sourceItem = items[0];
        const sourceId = getItemId(sourceItem);

        if (!nodeMap.has(sourceId)) {
          const node = itemToNode(sourceItem);
          nodeMap.set(sourceId, node);
          nodes.push(node);
        }

        // Outgoing Calls 가져오기
        const outgoingCalls: vscode.CallHierarchyOutgoingCall[] = await vscode.commands.executeCommand(
          'vscode.provideOutgoingCalls',
          sourceItem
        ) || [];

        for (const call of outgoingCalls) {
          const targetItem = call.to;
          const targetId = getItemId(targetItem);

          // 노드 리스트에 등록 (중복 방지)
          if (!nodeMap.has(targetId)) {
            const node = itemToNode(targetItem);
            nodeMap.set(targetId, node);
            nodes.push(node);
          }

          // 호출이 일어난 위치 정보 수집
          const callRanges = call.fromRanges.map((r: vscode.Range) => ({
            startLine: r.start.line,
            startCharacter: r.start.character,
            endLine: r.end.line,
            endCharacter: r.end.character
          }));

          edges.push({
            id: `${sourceId}->${targetId}`,
            source: sourceId,
            target: targetId,
            callRanges
          });
        }
      }
    }

    return { 
      nodes: injectGroupNodes(nodes), 
      edges 
    };
  } catch (err) {
    const res = analyzeFileCallGraphStatic(document);
    return { ...res, nodes: injectGroupNodes(res.nodes) };
  }
}

// ------------------- [ 정적 정규식 파서 Fallback 로직 ] -------------------

interface StaticFunc {
  name: string;
  startLine: number;
  endLine: number;
  bodyLines: string[];
}

// LSP 미동작 시 파일 코드를 정적으로 분석하는 로직
function analyzeFileCallGraphStatic(document: vscode.TextDocument) {
  const text = document.getText();
  const lines = text.split(/\r?\n/);

  const nodes: any[] = [];
  const edges: any[] = [];
  const functions: (StaticFunc & { className: string | null })[] = [];

  let currentFunc: StaticFunc | null = null;
  let currentIndent = 0;

  // 클래스 정보 추적
  let currentClass: string | null = null;
  let classIndent = 0;

  // 파이썬 함수 정의 및 클래스 정의 매칭 정규식
  const defRegex = /^(\s*)def\s+(\w+)\s*\(/;
  const classRegex = /^(\s*)class\s+(\w+)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1. 클래스 선언 매칭
    const classMatch = line.match(classRegex);
    if (classMatch) {
      if (currentFunc) {
        currentFunc.endLine = i - 1;
        functions.push({ ...currentFunc, className: currentClass });
        currentFunc = null;
      }
      currentClass = classMatch[2];
      classIndent = classMatch[1].length;
      continue;
    }

    // 2. 함수 선언 매칭
    const match = line.match(defRegex);
    if (match) {
      // 이전 함수 수집 완료 처리
      if (currentFunc) {
        currentFunc.endLine = i - 1;
        functions.push({ ...currentFunc, className: currentClass });
      }

      const indent = match[1].length;
      currentIndent = indent;

      // 만약 함수의 들여쓰기가 속해있는 클래스의 들여쓰기보다 작거나 같으면 클래스 컨텍스트 종료
      if (currentClass !== null && indent <= classIndent) {
        currentClass = null;
      }

      currentFunc = {
        name: match[2],
        startLine: i,
        endLine: i,
        bodyLines: []
      };
    } else if (currentFunc) {
      if (line.trim() === '') {
        currentFunc.bodyLines.push(line);
        continue;
      }

      const indentMatch = line.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[0].length : 0;

      // def보다 들여쓰기가 작거나 같은 새로운 실행문이 시작되면 함수 영역 끝으로 간주
      if (indent <= currentIndent && line.trim().length > 0) {
        currentFunc.endLine = i - 1;
        functions.push({ ...currentFunc, className: currentClass });
        currentFunc = null;

        // 클래스 바깥으로 나갔는지 체크
        if (currentClass !== null && indent <= classIndent) {
          currentClass = null;
        }
      } else {
        currentFunc.bodyLines.push(line);
      }
    }
  }

  if (currentFunc) {
    currentFunc.endLine = lines.length - 1;
    functions.push({ ...currentFunc, className: currentClass });
  }

  // 노드 변환
  functions.forEach(f => {
    const uri = document.uri.toString();
    const id = `${uri}#${f.name}@${f.startLine}:0`;
    const fileName = path.basename(document.fileName);

    const fileParentId = `${uri}#file_group`;
    let parentId = fileParentId;
    let classParentId = null;

    if (f.className) {
      classParentId = `${uri}#class_group#${f.className}`;
      parentId = classParentId;
    }

    nodes.push({
      id,
      label: f.name,
      detail: f.className ? `Line ${f.startLine + 1} (${f.className} 클래스 메서드)` : `Line ${f.startLine + 1} (정적 로컬 함수)`,
      uri,
      range: {
        startLine: f.startLine,
        startCharacter: 0,
        endLine: f.endLine,
        endCharacter: 100
      },
      isExternal: false,
      parent: parentId,
      fileParentId,
      classParentId,
      className: f.className,
      fileName
    });
  });

  // 엣지 변환 (호출 검출)
  functions.forEach(sourceFunc => {
    const sourceUri = document.uri.toString();
    const sourceId = `${sourceUri}#${sourceFunc.name}@${sourceFunc.startLine}:0`;

    functions.forEach(targetFunc => {
      // 자기 호출(재귀)은 단순화 위해 스킵
      if (sourceFunc.name === targetFunc.name) return;

      const callRanges: any[] = [];

      // 소스 함수 본문을 한 라인씩 돌며 타겟 함수가 호출되는 정확한 위치(라인) 계산
      sourceFunc.bodyLines.forEach((line, index) => {
        const callRegex = new RegExp(`\\b${targetFunc.name}\\s*\\(`, 'g');
        let match;
        while ((match = callRegex.exec(line)) !== null) {
          const actualLine = sourceFunc.startLine + 1 + index;
          callRanges.push({
            startLine: actualLine,
            startCharacter: match.index,
            endLine: actualLine,
            endCharacter: match.index + targetFunc.name.length
          });
        }
      });

      if (callRanges.length > 0) {
        const targetUri = document.uri.toString();
        const targetId = `${targetUri}#${targetFunc.name}@${targetFunc.startLine}:0`;
        edges.push({
          id: `${sourceId}->${targetId}`,
          source: sourceId,
          target: targetId,
          callRanges
        });
      }
    });
  });

  return { nodes, edges };
}

// 특정 위치의 노드 추가 기능에 대한 정적 분석 폴백
function analyzeFunctionAtPositionStatic(
  document: vscode.TextDocument,
  position: vscode.Position
) {
  const { nodes, edges } = analyzeFileCallGraphStatic(document);

  // 커서 라인이 선언 범위 내에 포함되는 함수 노드 찾기
  const activeNode = nodes.find(node => 
    position.line >= node.range.startLine && position.line <= node.range.endLine
  );

  if (!activeNode) {
    return null;
  }

  // 해당 노드에서 뻗어나가는(Outgoing) 엣지들만 필터링
  const outgoingEdges = edges.filter(edge => edge.source === activeNode.id);
  const targetIds = new Set(outgoingEdges.map(edge => edge.target));

  const filteredNodes = nodes.filter(node => 
    node.id === activeNode.id || targetIds.has(node.id)
  );

  return {
    mainNodeName: activeNode.label,
    nodes: filteredNodes,
    edges: outgoingEdges
  };
}

// CallHierarchyItem 고유 식별자 생성
function getItemId(item: vscode.CallHierarchyItem): string {
  // 동일 함수가 같은 파일/라인에 선언되어 있으므로 이를 ID로 사용
  return `${item.uri.toString()}#${item.name}@${item.range.start.line}:${item.range.start.character}`;
}

// CallHierarchyItem을 웹뷰 렌더링에 적합한 노드 구조로 변경
function itemToNode(item: vscode.CallHierarchyItem) {
  const isExternal = item.uri.scheme !== 'file';
  const fileName = path.basename(item.uri.fsPath);

  // 부모 ID 결정
  const fileParentId = `${item.uri.toString()}#file_group`;
  let parentId = fileParentId;

  // 클래스 소속 여부 (containerName이 있는 경우 클래스로 봄)
  let classParentId = null;
  if (item.containerName && item.containerName.trim() !== '') {
    classParentId = `${item.uri.toString()}#class_group#${item.containerName}`;
    parentId = classParentId;
  }

  return {
    id: getItemId(item),
    label: item.name,
    detail: item.detail || '',
    uri: item.uri.toString(),
    range: {
      startLine: item.range.start.line,
      startCharacter: item.range.start.character,
      endLine: item.range.end.line,
      endCharacter: item.range.end.character
    },
    isExternal,
    parent: parentId,
    fileParentId,
    classParentId,
    className: item.containerName || null,
    fileName
  };
}

// Webview 표시 및 라이프사이클 관리
function showWebview(
  context: vscode.ExtensionContext,
  titleSuffix: string,
  nodes: any[],
  edges: any[]
) {
  if (activePanel) {
    // 이미 존재하는 웹뷰 패널이 있다면 데이터 전달 후 포커스
    activePanel.webview.postMessage({ type: 'setData', nodes, edges });
    activePanel.reveal(vscode.ViewColumn.Two);
    return;
  }

  activePanel = vscode.window.createWebviewPanel(
    'pythonCallGraph',
    `Call Graph: ${titleSuffix}`,
    vscode.ViewColumn.Two,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, 'src'))
      ]
    }
  );

  // HTML 내용 채우기
  const htmlPath = path.join(context.extensionPath, 'src', 'webview.html');
  let htmlContent = fs.readFileSync(htmlPath, 'utf8');

  // 웹뷰에 HTML 주입
  activePanel.webview.html = htmlContent;

  // 웹뷰 준비 완료 시 초기 데이터 전달
  activePanel.webview.onDidReceiveMessage(async (message) => {
    switch (message.type) {
      case 'ready':
        activePanel?.webview.postMessage({ type: 'setData', nodes, edges });
        break;
      case 'goToSource':
        await navigateToSource(message.payload);
        break;
    }
  });

  activePanel.onDidDispose(() => {
    activePanel = undefined;
  });
}

// 웹뷰에서 전달받은 위치로 코드 이동
async function navigateToSource(payload: {
  uri: string;
  range: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
}) {
  try {
    const fileUri = vscode.Uri.parse(payload.uri);
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

    const start = new vscode.Position(payload.range.startLine, payload.range.startCharacter);
    const end = new vscode.Position(payload.range.endLine, payload.range.endCharacter);
    const selectionRange = new vscode.Range(start, end);

    editor.selection = new vscode.Selection(start, start);
    editor.revealRange(selectionRange, vscode.TextEditorRevealType.InCenter);
    
    // 포커싱 데코레이션
    const decorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(100, 150, 255, 0.3)',
      isWholeLine: true
    });
    editor.setDecorations(decorationType, [selectionRange]);
    setTimeout(() => decorationType.dispose(), 1500);
  } catch (error: any) {
    vscode.window.showErrorMessage(`코드 위치로 이동 실패: ${error.message}`);
  }
}

export function deactivate() {
  if (activePanel) {
    activePanel.dispose();
  }
}
