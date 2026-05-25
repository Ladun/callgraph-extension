import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let activePanel: vscode.WebviewPanel | undefined = undefined;

export async function activate(context: vscode.ExtensionContext) {
  // Python 확장 기능이 설치되어 있고 활성화되지 않았다면 명시적으로 활성화 대기
  // Python 및 C# 확장 기능이 설치되어 있고 활성화되지 않았다면 명시적으로 활성화 대기
  try {
    const pythonExtension = vscode.extensions.getExtension('ms-python.python');
    if (pythonExtension && !pythonExtension.isActive) {
      await pythonExtension.activate();
    }
  } catch (err) {
    console.error('Python extension activation failed:', err);
  }

  try {
    const csharpExtension = vscode.extensions.getExtension('ms-dotnettools.csharp');
    if (csharpExtension && !csharpExtension.isActive) {
      await csharpExtension.activate();
    }
  } catch (err) {
    console.error('C# extension activation failed:', err);
  }

  // 1. 파일 전체 호출 그래프 보기 커맨드
  let viewGraphDisposable = vscode.commands.registerCommand(
    'callgraph.viewFileGraph',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('활성화된 에디터가 없습니다.');
        return;
      }
      
      const document = editor.document;
      if (document.languageId !== 'python' && document.languageId !== 'csharp') {
        vscode.window.showErrorMessage('Python 또는 C# 파일에서만 Call Graph를 생성할 수 있습니다.');
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
    'callgraph.addFunctionToGraph',
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
    if (document.languageId === 'csharp') {
      throw new Error('C# LSP Call Hierarchy API를 사용할 수 없습니다. Microsoft C# 확장이 정상 설치되어 있으며, 프로젝트 빌드 오류가 없는지 확인해 주세요.');
    }
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

    const rawEdges: any[] = [];

    for (const call of outgoingCalls) {
      const targetItem = call.to;
      const targetNodeId = getItemId(targetItem);

      // 노드가 중복되지 않도록 추가
      if (!nodes.some(n => n.id === targetNodeId)) {
        nodes.push(itemToNode(targetItem));
      }

      // 호출 마다 개별 엣지 생성 (다중 호출/시퀀스 지원)
      call.fromRanges.forEach((r: vscode.Range) => {
        rawEdges.push({
          source: mainNodeId,
          target: targetNodeId,
          callLine: r.start.line,
          callChar: r.start.character,
          range: {
            startLine: r.start.line,
            startCharacter: r.start.character,
            endLine: r.end.line,
            endCharacter: r.end.character
          }
        });
      });
    }

    // 호출 순서(라인 및 캐릭터 기준) 오름차순 정렬
    rawEdges.sort((a, b) => {
      if (a.callLine !== b.callLine) return a.callLine - b.callLine;
      return a.callChar - b.callChar;
    });

    // 엣지 최종 정제 및 순서 정보 부여
    rawEdges.forEach((edge, index) => {
      const order = index + 1;
      const orderCircle = getCircleNumber(order);
      edges.push({
        id: `${edge.source}->${edge.target}@line_${edge.callLine}_char_${edge.callChar}`,
        source: edge.source,
        target: edge.target,
        order: order,
        orderLabel: `${orderCircle} [L. ${edge.callLine + 1}]`,
        callRanges: [edge.range] // 웹뷰 호환성 유지
      });
    });

    // 하이브리드 보완: 정적 분석 결과 중 매직 메소드 노드 및 엣지를 병합
    try {
      const staticRes = analyzeFileCallGraphStatic(document);
      staticRes.nodes.forEach(sNode => {
        if (sNode.isMagic && !nodes.some(n => n.id === sNode.id)) {
          nodes.push(sNode);
        }
      });
      staticRes.edges.forEach(sEdge => {
        const isMagicEdge = sEdge.source.includes('__') || sEdge.target.includes('__');
        if (isMagicEdge && !edges.some(e => e.id === sEdge.id)) {
          edges.push(sEdge);
        }
      });
    } catch (e) {
      console.error('Failed to merge static magic methods:', e);
    }

    redirectClassEdgesToConstructor(nodes, edges);
    return {
      mainNodeName: mainItem.name,
      nodes: injectGroupNodes(nodes),
      edges
    };
  } catch (err) {
    if (document.languageId === 'csharp') {
      throw new Error(`C# 호출 계층 분석 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
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
    if (document.languageId === 'csharp') {
      throw new Error('C# LSP Call Hierarchy API를 사용할 수 없습니다. Microsoft C# 확장이 정상 설치되어 있으며, 프로젝트 빌드 오류가 없는지 확인해 주세요.');
    }
    console.log('Call Hierarchy API unavailable. Falling back to static file call graph analysis.');
    const res = analyzeFileCallGraphStatic(document);
    return { ...res, nodes: injectGroupNodes(res.nodes) };
  }

  try {
    const nodes: any[] = [];
    const edges: any[] = [];
    const rawEdges: any[] = []; // 원본 엣지 임시 수집용 배열 추가
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
      if (document.languageId === 'csharp') {
        throw new Error('C# 파일에서 메서드 심볼을 추출할 수 없습니다. 컴파일 오류가 없는지 확인해 주세요.');
      }
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

          // 호출 마다 개별 엣지 생성 (다중 호출/시퀀스 지원)
          call.fromRanges.forEach((r: vscode.Range) => {
            rawEdges.push({
              source: sourceId,
              target: targetId,
              callLine: r.start.line,
              callChar: r.start.character,
              range: {
                startLine: r.start.line,
                startCharacter: r.start.character,
                endLine: r.end.line,
                endCharacter: r.end.character
              }
            });
          });
        }
      }
    }

    // 소스 함수 단위로 그룹화하여 순서 정렬 및 엣지 추가
    const edgesBySource = new Map<string, any[]>();
    rawEdges.forEach(edge => {
      if (!edgesBySource.has(edge.source)) {
        edgesBySource.set(edge.source, []);
      }
      edgesBySource.get(edge.source)!.push(edge);
    });

    // 각 소스 함수 그룹 내부에서 정렬 및 최종 엣지 등록
    edgesBySource.forEach((srcEdges, sourceId) => {
      srcEdges.sort((a, b) => {
        if (a.callLine !== b.callLine) return a.callLine - b.callLine;
        return a.callChar - b.callChar;
      });

      srcEdges.forEach((edge, index) => {
        const order = index + 1;
        const orderCircle = getCircleNumber(order);
        edges.push({
          id: `${edge.source}->${edge.target}@line_${edge.callLine}_char_${edge.callChar}`,
          source: edge.source,
          target: edge.target,
          order: order,
          orderLabel: `${orderCircle} [L. ${edge.callLine + 1}]`,
          callRanges: [edge.range]
        });
      });
    });

    // 하이브리드 보완: 정적 분석 결과 중 매직 메소드 노드 및 엣지를 병합
    try {
      const staticRes = analyzeFileCallGraphStatic(document);
      staticRes.nodes.forEach(sNode => {
        if (sNode.isMagic && !nodes.some(n => n.id === sNode.id)) {
          nodes.push(sNode);
        }
      });
      staticRes.edges.forEach(sEdge => {
        const isMagicEdge = sEdge.source.includes('__') || sEdge.target.includes('__');
        if (isMagicEdge && !edges.some(e => e.id === sEdge.id)) {
          edges.push(sEdge);
        }
      });
    } catch (e) {
      console.error('Failed to merge static magic methods:', e);
    }

    redirectClassEdgesToConstructor(nodes, edges);
    return { 
      nodes: injectGroupNodes(nodes), 
      edges 
    };
  } catch (err) {
    if (document.languageId === 'csharp') {
      throw new Error(`C# 호출 관계 분석 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
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

  // 1. 파일 전체 텍스트에서 임포트 정보 파싱 (외부 클래스 및 모듈 경로 획득)
  let workspaceRoot = '';
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (folder) {
    workspaceRoot = folder.uri.fsPath;
  } else {
    workspaceRoot = path.dirname(document.fileName);
  }

  const importedItemsMap = new Map<string, { modulePath: string, uri: string, fileName: string, isClass: boolean }>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // from module import name1, name2
    const fromMatch = line.match(/^\s*from\s+([\w\.]+)\s+import\s+([\w\s,]+)/);
    if (fromMatch) {
      const modulePath = fromMatch[1];
      const names = fromMatch[2].split(',').map(n => n.trim());
      names.forEach(name => {
        let importName = name;
        const asMatch = name.match(/(\w+)\s+as\s+(\w+)/);
        if (asMatch) {
          importName = asMatch[2];
        }
        
        const isClass = /^[A-Z]/.test(importName);
        const relPath = modulePath.replace(/\./g, '/');
        const candidates = [
          path.join(workspaceRoot, `${relPath}.py`),
          path.join(workspaceRoot, relPath, '__init__.py'),
          path.join(path.dirname(document.fileName), `${relPath}.py`),
          path.join(path.dirname(document.fileName), relPath, '__init__.py')
        ];
        let resolvedUri = `external://${modulePath}`;
        let resolvedFileName = `${modulePath.split('.').pop()}.py`;
        for (const cand of candidates) {
          if (fs.existsSync(cand)) {
            resolvedUri = vscode.Uri.file(cand).toString();
            resolvedFileName = path.basename(cand);
            break;
          }
        }
        importedItemsMap.set(importName, {
          modulePath,
          uri: resolvedUri,
          fileName: resolvedFileName,
          isClass
        });
      });
    }

    // import module as alias
    const importMatch = line.match(/^\s*import\s+([\w\.]+)(?:\s+as\s+(\w+))?/);
    if (importMatch) {
      const modulePath = importMatch[1];
      const alias = importMatch[2];
      const importName = alias || modulePath.split('.').pop() || '';
      
      const isClass = /^[A-Z]/.test(importName);
      const relPath = modulePath.replace(/\./g, '/');
      const candidates = [
        path.join(workspaceRoot, `${relPath}.py`),
        path.join(workspaceRoot, relPath, '__init__.py'),
        path.join(path.dirname(document.fileName), `${relPath}.py`),
        path.join(path.dirname(document.fileName), relPath, '__init__.py')
      ];
      let resolvedUri = `external://${modulePath}`;
      let resolvedFileName = `${modulePath.split('.').pop()}.py`;
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          resolvedUri = vscode.Uri.file(cand).toString();
          resolvedFileName = path.basename(cand);
          break;
        }
      }
      importedItemsMap.set(importName, {
        modulePath,
        uri: resolvedUri,
        fileName: resolvedFileName,
        isClass
      });
    }
  }

  let currentFunc: StaticFunc | null = null;
  let currentIndent = 0;

  // 클래스 정보 추적
  let currentClass: string | null = null;
  let classIndent = 0;

  // 파이썬 함수 정의 및 클래스 정의 매칭 정규식
  const defRegex = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/;
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

  // 파일 내 정의된 클래스 이름 목록 구성
  const classNames = new Set<string>();
  functions.forEach(f => {
    if (f.className) {
      classNames.add(f.className);
    }
  });
  // 외부 클래스명도 추가
  importedItemsMap.forEach((val, key) => {
    if (val.isClass) {
      classNames.add(key);
    }
  });

  // 3. 외부 클래스의 가상 생성자 및 외부 모듈 함수 발굴
  interface VirtualFunc extends StaticFunc {
    className: string | null;
    isExternal: boolean;
    externalUri: string;
    externalFileName: string;
  }
  const virtualFunctions: VirtualFunc[] = [];

  importedItemsMap.forEach((info, importName) => {
    if (info.isClass) {
      // 1) 외부 클래스 생성자 호출 감지
      const constRegex = new RegExp(`\\b${importName}\\s*\\(`, 'g');
      let isInstantiated = false;
      if (!text.includes(`class ${importName}`)) {
        isInstantiated = constRegex.test(text);
      }
      if (isInstantiated) {
        const candPath = info.uri.startsWith('file://') ? vscode.Uri.parse(info.uri).fsPath : '';
        const defLine = candPath ? getMethodStartLineInFile(candPath, importName, '__init__') : 0;
        virtualFunctions.push({
          name: '__init__',
          className: importName,
          startLine: defLine,
          endLine: defLine,
          bodyLines: [],
          isExternal: true,
          externalUri: info.uri,
          externalFileName: info.fileName
        });
      }
    } else {
      // 2) 외부 모듈 전역 함수 호출 감지
      const funcRegex = new RegExp(`\\b${importName}\\s*\\(`, 'g');
      let isCalled = false;
      if (!text.includes(`def ${importName}`)) {
        isCalled = funcRegex.test(text);
      }
      if (isCalled) {
        const candPath = info.uri.startsWith('file://') ? vscode.Uri.parse(info.uri).fsPath : '';
        const defLine = candPath ? getMethodStartLineInFile(candPath, null, importName) : 0;
        virtualFunctions.push({
          name: importName,
          className: null,
          startLine: defLine,
          endLine: defLine,
          bodyLines: [],
          isExternal: true,
          externalUri: info.uri,
          externalFileName: info.fileName
        });
      }
    }
  });

  // functions와 virtualFunctions를 모두 합한 allFunctions 구성
  const allFunctions = [
    ...functions.map(f => ({ ...f, isExternal: false, externalUri: '', externalFileName: '' })),
    ...virtualFunctions
  ];

  // 로컬 노드 변환
  functions.forEach(f => {
    const uri = document.uri.toString();
    const id = `${uri}#${f.name}@${f.startLine}`;
    const fileName = path.basename(document.fileName);

    const fileParentId = `${uri}#file_group`;
    let parentId = fileParentId;
    let classParentId = null;

    if (f.className) {
      classParentId = `${uri}#class_group#${f.className}`;
      parentId = classParentId;
    }

    const isMagic = f.name.startsWith('__') && f.name.endsWith('__');
    const isAsync = lines[f.startLine] ? lines[f.startLine].includes('async ') : false;

    nodes.push({
      id,
      label: getDunderMethodLabel(f.name),
      detail: f.className ? `Line ${f.startLine + 1} (${f.className} 클래스 메서드)` : `Line ${f.startLine + 1} (정적 로컬 함수)`,
      uri,
      range: {
        startLine: f.startLine,
        startCharacter: 0,
        endLine: f.endLine,
        endCharacter: 100
      },
      isExternal: false,
      isMagic,
      isAsync,
      parent: parentId,
      fileParentId,
      classParentId,
      className: f.className,
      fileName
    });
  });

  // 외부 가상 노드 변환 및 nodes에 등록
  virtualFunctions.forEach(f => {
    const uri = f.externalUri;
    const id = `${uri}#${f.name}@${f.startLine}`;
    const fileName = f.externalFileName;

    const fileParentId = `${uri}#file_group`;
    let parentId = fileParentId;
    let classParentId = null;

    if (f.className) {
      classParentId = `${uri}#class_group#${f.className}`;
      parentId = classParentId;
    }

    nodes.push({
      id,
      label: getDunderMethodLabel(f.name),
      detail: f.className ? `외부 클래스 생성자 메서드` : `외부 모듈 전역 함수`,
      uri,
      range: {
        startLine: f.startLine,
        startCharacter: 0,
        endLine: f.startLine,
        endCharacter: 100
      },
      isExternal: true,
      isMagic: f.name.startsWith('__') && f.name.endsWith('__'),
      isAsync: false,
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
    const sourceId = `${sourceUri}#${sourceFunc.name}@${sourceFunc.startLine}`;

    const rawEdges: any[] = [];
    const localVarsTypeMap = new Map<string, string>();

    // sourceFunc.bodyLines를 돌며 변수 타입 선언 매칭 (예: acc = Account("Alice"))
    sourceFunc.bodyLines.forEach(line => {
      // 1) 대입문: acc = Account(...)
      const assignMatch = line.match(/\b(\w+)\s*=\s*([A-Za-z_]\w*)\s*\(/);
      if (assignMatch) {
        const varName = assignMatch[1];
        const className = assignMatch[2];
        if (classNames.has(className)) {
          localVarsTypeMap.set(varName, className);
        }
      }
      // 2) with문 바인딩: with Account(...) as acc: 또는 with context as acc:
      const withMatch = line.match(/\bwith\s+([A-Za-z_]\w*)(?:\([^)]*\))?\s+as\s+(\w+)/);
      if (withMatch) {
        const sourceVarOrClass = withMatch[1];
        const boundVar = withMatch[2];
        if (classNames.has(sourceVarOrClass)) {
          localVarsTypeMap.set(boundVar, sourceVarOrClass);
        } else if (localVarsTypeMap.has(sourceVarOrClass)) {
          localVarsTypeMap.set(boundVar, localVarsTypeMap.get(sourceVarOrClass)!);
        }
      }
    });

    // 2) 외부 클래스의 일반 메서드 호출 동적 발굴
    sourceFunc.bodyLines.forEach(line => {
      const methodCallRegex = /\b(\w+)\.(\w+)\s*\(/g;
      let m;
      while ((m = methodCallRegex.exec(line)) !== null) {
        const varName = m[1];
        const methodName = m[2];
        
        // __init__ 등 특수 호출 제외
        if (methodName === '__init__' || methodName === '__new__') continue;

        if (localVarsTypeMap.has(varName)) {
          const className = localVarsTypeMap.get(varName)!;
          if (importedItemsMap.has(className)) {
            const info = importedItemsMap.get(className)!;
            
            const candPath = info.uri.startsWith('file://') ? vscode.Uri.parse(info.uri).fsPath : '';
            const defLine = candPath ? getMethodStartLineInFile(candPath, className, methodName) : 0;
            const virtualId = `${info.uri}#${methodName}@${defLine}`;
            
            // allFunctions 및 nodes 에 이미 등록되었는지 검사
            const alreadyExists = allFunctions.some(f => f.className === className && f.name === methodName);
            if (!alreadyExists) {
              const newVirtual: VirtualFunc = {
                name: methodName,
                className: className,
                startLine: defLine,
                endLine: defLine,
                bodyLines: [],
                isExternal: true,
                externalUri: info.uri,
                externalFileName: info.fileName
              };
              virtualFunctions.push(newVirtual);
              allFunctions.push({ ...newVirtual, isExternal: true });

              // nodes 배열에도 등록
              const fileParentId = `${info.uri}#file_group`;
              let parentId = fileParentId;
              let classParentId = null;
              if (className) {
                classParentId = `${info.uri}#class_group#${className}`;
                parentId = classParentId;
              }

              nodes.push({
                id: virtualId,
                label: getDunderMethodLabel(methodName),
                detail: `외부 클래스 메서드`,
                uri: info.uri,
                range: {
                  startLine: defLine,
                  startCharacter: 0,
                  endLine: defLine,
                  endCharacter: 100
                },
                isExternal: true,
                isMagic: methodName.startsWith('__') && methodName.endsWith('__'),
                isAsync: false,
                parent: parentId,
                fileParentId,
                classParentId,
                className: className,
                fileName: info.fileName
              });
            }
          }
        }
      }
    });

    allFunctions.forEach(targetFunc => {
      // 자기 호출(재귀)은 단순화 위해 스킵
      if (sourceFunc.name === targetFunc.name && sourceFunc.className === targetFunc.className) return;

      // 소스 함수 본문을 한 라인씩 돌며 타겟 함수가 호출되는 정확한 위치(라인) 계산
      sourceFunc.bodyLines.forEach((line, index) => {
        const actualLineZero = sourceFunc.startLine + index; // 0-indexed 라인 번호
        let callIndices: number[] = [];

        // 1. 직접 명시적 호출 매칭: obj.method_name(args) 또는 method_name(args)
        // (단, 생성자 메서드 __init__ 등은 직접 obj.__init__으로 호출하지 않는 한 건너뜀)
        const isConstructor = targetFunc.name === '__init__' || targetFunc.name === '__new__';
        if (!isConstructor) {
          const directRegex = new RegExp(`\\b${targetFunc.name}\\s*\\(`, 'g');
          let match;
          while ((match = directRegex.exec(line)) !== null) {
            callIndices.push(match.index);
          }
        }

        // 2. 클래스 생성자 간접 호출 매칭: ClassName(...) -> ClassName.__init__
        if (targetFunc.className && (targetFunc.name === '__init__' || targetFunc.name === '__new__')) {
          const constRegex = new RegExp(`\\b${targetFunc.className}\\s*\\(`, 'g');
          let match;
          while ((match = constRegex.exec(line)) !== null) {
            if (!line.includes(`class ${targetFunc.className}`)) {
              callIndices.push(match.index);
            }
          }
          // super().__init__() 호출 매칭
          if (targetFunc.name === '__init__' && line.includes('super()')) {
            const superRegex = /\bsuper\s*\(\s*\)\s*\.\s*__init__\s*\(/g;
            while ((match = superRegex.exec(line)) !== null) {
              callIndices.push(match.index);
            }
          }
        }

        // 3. 매직 메소드 간접 호출 매칭 (타입 추적 및 컨텍스트 매칭)
        if (targetFunc.className) {
          const className = targetFunc.className;
          const methodName = targetFunc.name;

          const typedVars = Array.from(localVarsTypeMap.entries())
            .filter(([v, t]) => t === className)
            .map(([v, t]) => v);

          const isSelfContext = sourceFunc.className === className;
          let match;

          if (methodName === '__repr__') {
            typedVars.forEach(v => {
              const regex = new RegExp(`\\brepr\\s*\\(\\s*${v}\\s*\\)`, 'g');
              while ((match = regex.exec(line)) !== null) {
                callIndices.push(match.index);
              }
            });
            if (isSelfContext) {
              const regex = /\brepr\s*\(\s*self\s*\)/g;
              while ((match = regex.exec(line)) !== null) {
                callIndices.push(match.index);
              }
            }
          } else if (methodName === '__str__') {
            typedVars.forEach(v => {
              const regex = new RegExp(`\\bstr\\s*\\(\\s*${v}\\s*\\)`, 'g');
              while ((match = regex.exec(line)) !== null) {
                callIndices.push(match.index);
              }
            });
            if (isSelfContext) {
              const regex = /\bstr\s*\(\s*self\s*\)/g;
              while ((match = regex.exec(line)) !== null) {
                callIndices.push(match.index);
              }
            }
          } else if (methodName === '__del__') {
            typedVars.forEach(v => {
              const regex = new RegExp(`\\bdel\\s+${v}\\b`, 'g');
              while ((match = regex.exec(line)) !== null) {
                callIndices.push(match.index);
              }
            });
          } else if (methodName === '__enter__' || methodName === '__exit__') {
            typedVars.forEach(v => {
              const regex = new RegExp(`\\bwith\\s+${v}\\b`, 'g');
              while ((match = regex.exec(line)) !== null) {
                callIndices.push(match.index);
              }
            });
            const regex = new RegExp(`\\bwith\\s+${className}\\s*\\(`, 'g');
            while ((match = regex.exec(line)) !== null) {
              callIndices.push(match.index);
            }
          } else if (methodName === '__aenter__' || methodName === '__aexit__') {
            typedVars.forEach(v => {
              const regex = new RegExp(`\\basync\\s+with\\s+${v}\\b`, 'g');
              while ((match = regex.exec(line)) !== null) {
                callIndices.push(match.index);
              }
            });
            const regex = new RegExp(`\\basync\\s+with\\s+${className}\\s*\\(`, 'g');
            while ((match = regex.exec(line)) !== null) {
              callIndices.push(match.index);
            }
          } else if (methodName === '__call__') {
            typedVars.forEach(v => {
              const regex = new RegExp(`\\b${v}\\s*\\(`, 'g');
              while ((match = regex.exec(line)) !== null) {
                const isLeftOfEquals = new RegExp(`^\\s*${v}\\s*=`).test(line);
                if (!isLeftOfEquals) {
                  callIndices.push(match.index);
                }
              }
            });
          } else if (methodName === '__getitem__' || methodName === '__setitem__') {
            typedVars.forEach(v => {
              const regex = new RegExp(`\\b${v}\\s*\\[`, 'g');
              while ((match = regex.exec(line)) !== null) {
                callIndices.push(match.index);
              }
            });
          } else if (methodName === '__len__') {
            typedVars.forEach(v => {
              const regex = new RegExp(`\\blen\\s*\\(\\s*${v}\\s*\\)`, 'g');
              while ((match = regex.exec(line)) !== null) {
                callIndices.push(match.index);
              }
            });
          }
        }

        const uniqueIndices = Array.from(new Set(callIndices));
        uniqueIndices.forEach(charIndex => {
          const targetUri = targetFunc.isExternal ? targetFunc.externalUri : sourceUri;
          rawEdges.push({
            source: sourceId,
            target: `${targetUri}#${targetFunc.name}@${targetFunc.startLine}`,
            callLine: actualLineZero,
            callChar: charIndex,
            range: {
              startLine: actualLineZero,
              startCharacter: charIndex,
              endLine: actualLineZero,
              endCharacter: charIndex + targetFunc.name.length
            }
          });
        });
      });
    });

    // 라인 및 캐릭터 순서 정렬
    rawEdges.sort((a, b) => {
      if (a.callLine !== b.callLine) return a.callLine - b.callLine;
      return a.callChar - b.callChar;
    });

    // 정렬된 순서대로 엣지 할당
    rawEdges.forEach((edge, index) => {
      const order = index + 1;
      const orderCircle = getCircleNumber(order);
      edges.push({
        id: `${edge.source}->${edge.target}@line_${edge.callLine}_char_${edge.callChar}`,
        source: edge.source,
        target: edge.target,
        order: order,
        orderLabel: `${orderCircle} [L. ${edge.callLine + 1}]`,
        callRanges: [edge.range]
      });
    });
  });

  redirectClassEdgesToConstructor(nodes, edges);
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
  // 동일 함수가 같은 파일/라인에 선언되어 있으므로 이를 ID로 사용 (character 오프셋 불일치 버그 예방을 위해 line 까지만 사용)
  return `${item.uri.toString()}#${item.name}@${item.range.start.line}`;
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

  // 매직 메소드 여부 판별
  const isMagic = item.name.startsWith('__') && item.name.endsWith('__');

  // 비동기 함수 여부 판별
  let isAsync = false;
  try {
    if (item.uri.scheme === 'file') {
      const filePath = item.uri.fsPath;
      if (fs.existsSync(filePath)) {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const fileLines = fileContent.split(/\r?\n/);
        const lineText = fileLines[item.range.start.line];
        if (lineText && lineText.includes('async ')) {
          isAsync = true;
        }
      }
    }
  } catch (e) {
    console.error('Failed to read async def status:', e);
  }

  return {
    id: getItemId(item),
    label: getDunderMethodLabel(item.name),
    detail: item.detail || '',
    uri: item.uri.toString(),
    range: {
      startLine: item.range.start.line,
      startCharacter: item.range.start.character,
      endLine: item.range.end.line,
      endCharacter: item.range.end.character
    },
    isExternal,
    isMagic,
    isAsync,
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
    'callGraph',
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

// 엣지 순서 번호를 동그라미 기호로 변환해주는 헬퍼 함수
function getCircleNumber(num: number): string {
  const circles = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];
  return num <= 20 ? circles[num - 1] : `(${num})`;
}

// 파이썬 매직 메소드(Dunder Methods)의 라벨을 가독성 높게 다듬어주는 헬퍼 함수
function getDunderMethodLabel(name: string): string {
  const labels: Record<string, string> = {
    '__init__': '__init__ (Constructor)',
    '__del__': '__del__ (Destructor)',
    '__repr__': '__repr__ (String Repr)',
    '__str__': '__str__ (String Conversion)',
    '__call__': '__call__ (Callable Init)',
    '__new__': '__new__ (Instance Alloc)',
    '__enter__': '__enter__ (Context Enter)',
    '__exit__': '__exit__ (Context Exit)',
    '__aenter__': '__aenter__ (Async Context Enter)',
    '__aexit__': '__aexit__ (Async Context Exit)',
    '__getitem__': '__getitem__ (Get Item)',
    '__setitem__': '__setitem__ (Set Item)',
    '__iter__': '__iter__ (Get Iterator)',
    '__next__': '__next__ (Next Iteration)',
    '__len__': '__len__ (Get Length)',
    '__eq__': '__eq__ (Equal To)',
    '__lt__': '__lt__ (Less Than)',
    '__gt__': '__gt__ (Greater Than)',
    '__le__': '__le__ (Less or Equal)',
    '__ge__': '__ge__ (Greater or Equal)',
    '__ne__': '__ne__ (Not Equal)',
    '__add__': '__add__ (Add Operator)',
    '__sub__': '__sub__ (Sub Operator)',
    '__mul__': '__mul__ (Mul Operator)',
    '__truediv__': '__truediv__ (Div Operator)'
  };
  return labels[name] || name;
}

// 클래스 노드를 가리키는 호출 엣지를 해당 클래스 내부의 __init__ 생성자 노드로 자동 우회(Redirect)시켜주는 함수
function redirectClassEdgesToConstructor(nodes: any[], edges: any[]) {
  // 1. 각 클래스 이름에 대해 그 클래스의 __init__ 노드 ID를 매핑한다.
  const classToInitMap = new Map<string, string>(); // className -> __init__ node id

  nodes.forEach(node => {
    // 만약 이 노드가 __init__ 메서드라면 (정적 분석 또는 LSP 분석 모두 포함)
    if (node.className && node.label && (node.label.startsWith('__init__') || node.label.includes('__init__'))) {
      classToInitMap.set(node.className, node.id);
    }
  });

  // 2. 엣지를 돌면서, 타겟 노드가 클래스 노드 자체인 경우에만 __init__ 생성자 노드로 우회
  edges.forEach(edge => {
    const targetNode = nodes.find(n => n.id === edge.target);
    if (targetNode) {
      // 중요: targetNode가 일반 메서드 노드(예: store, update, step)라면 우회하면 안 됨.
      // 오직 targetNode가 클래스 자체 노드(LSP 심볼 등)인 경우에만 생성자(__init__)로 우회시킴.
      let className: string | null = null;
      
      const isMethodNode = targetNode.label && (
        targetNode.label.includes('(') || 
        targetNode.label.includes(' ') || 
        targetNode.label.startsWith('__') ||
        (targetNode.className && targetNode.label !== targetNode.className)
      );

      if (!isMethodNode) {
        if (targetNode.className) {
          className = targetNode.className;
        } else if (!targetNode.isGroup && targetNode.label && !targetNode.label.includes('(') && !targetNode.label.includes(' ')) {
          className = targetNode.label;
        }
      }

      if (className && classToInitMap.has(className)) {
        const initNodeId = classToInitMap.get(className)!;
        edge.target = initNodeId;
        
        // 엣지 ID 업데이트
        const parts = edge.id.split('@');
        const suffix = parts.length > 1 ? `@${parts[1]}` : '';
        edge.id = `${edge.source}->${initNodeId}${suffix}`;
      }
    }
    
    // 만약 타겟 ID가 직접 클래스 그룹 ID인 경우에 대한 대비
    if (edge.target.includes('#class_group#')) {
    }
  });
}

// 외부 파일에서 메서드 및 함수가 선언된 실제 라인 번호를 역추적하는 헬퍼 함수
function getMethodStartLineInFile(filePath: string, className: string | null, methodName: string): number {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/);
      
      let currentClass: string | null = null;
      let classIndent = 0;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        const classMatch = line.match(/^(\s*)class\s+(\w+)/);
        if (classMatch) {
          currentClass = classMatch[2];
          classIndent = classMatch[1].length;
          continue;
        }
        
        const defMatch = line.match(/^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/);
        if (defMatch) {
          const indent = defMatch[1].length;
          const defName = defMatch[2];
          
          if (currentClass !== null && indent <= classIndent) {
            currentClass = null;
          }
          
          if (className) {
            if (currentClass === className && defName === methodName) {
              return i;
            }
          } else {
            if (currentClass === null && defName === methodName) {
              return i;
            }
          }
        }
      }
    }
  } catch (e) {
    console.error(`Failed to find line for ${methodName} in ${filePath}`, e);
  }
  return 0;
}

