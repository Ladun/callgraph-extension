# VS Code 마켓플레이스 배포 가이드 (Publishing Guide)

이 문서는 본 확장 프로그램(`callgraph-extension`)을 Visual Studio Marketplace에 패키징하고 최종 배포하기 위한 모든 단계를 담고 있습니다.

---

## 1. 사전 준비 작업

### A. 마이크로소프트 Personal Access Token (PAT) 발급
VS Code Marketplace에 CLI 도구로 인증하여 업로드하려면 Azure DevOps를 통한 토큰 발급이 필요합니다.

1. **[Azure DevOps](https://dev.azure.com/)**에 Microsoft 계정으로 로그인합니다.
2. 우측 상단의 **프로필 설정 아이콘 (톱니바퀴 옆)** ➔ **Personal Access Tokens**를 클릭합니다.
3. **New Token** 버튼을 클릭하여 새 토큰을 생성합니다:
   - **Name**: `vsce-publisher`
   - **Organization**: **All accessible organizations** (반드시 전체 조직으로 선택해야 함)
   - **Scopes**: 맨 아래 `Show all scopes`를 클릭하여 모든 범위를 연 뒤, **Marketplace** 항목을 찾아 **Acquire** 및 **Manage**를 체크합니다. (또는 편의상 `Full Access`로 지정해도 됨)
4. **Create**를 누른 뒤 화면에 나타나는 **토큰 문자열을 복사하여 보관**합니다. (창을 닫으면 재확인이 불가능합니다.)

### B. Marketplace Publisher(게시자) 계정 생성
1. **[VS Code Marketplace 관리 페이지](https://marketplace.visualstudio.com/manage)**로 이동합니다.
2. 사용할 **Publisher ID**와 이름을 등록합니다.
   - **⚠️ 중요**: 이 게시자 ID는 `package.json`의 `"publisher"` 필드 값과 정확히 일치해야 합니다. 현재 프로젝트의 기본값은 `"<publisher id>"`로 되어 있으므로 필요 시 `package.json`을 수정해 주세요.

---

## 2. 확장 프로그램 빌드 및 패키징 (Local VSIX)

로컬 환경에서 실제 설치 가능한 확장 프로그램 패키지(`.vsix` 파일)를 생성하는 방법입니다.

프로젝트 루트 폴더(`callgraph-extension`) 터미널에서 다음 명령어를 실행합니다.
```bash
npx @vscode/vsce package --allow-missing-repository
```
- 이 명령어를 실행하면 `esbuild` 컴파일을 수행한 후, 프로젝트 루트에 `callgraph-extension-0.1.0.vsix` 파일이 생성됩니다.
- 생성된 `.vsix` 파일은 타인에게 공유하거나 본인의 VS Code에서 `VSIX에서 설치...` 기능을 통해 즉시 로컬 설치하여 테스트할 수 있습니다.

---

## 3. 마켓플레이스 배포 (Publish)

마켓플레이스에 공식 업로드하여 누구나 검색 후 다운로드받을 수 있도록 하는 방법입니다.

### 방법 1. CLI(터미널)를 통한 자동 배포 (권장)
1. **vsce 로그인 수행** (여기서 `<publisher id>`는 본인의 Publisher ID입니다):
   ```bash
   npx @vscode/vsce login <publisher id>
   ```
   - 실행 시 입력 프롬프트가 뜨면 **1단계에서 발급받은 Azure DevOps PAT 토큰**을 붙여넣고 엔터를 칩니다. (`Login successful!` 문구가 나오면 성공)

2. **최종 배포 실행**:
   ```bash
   npx @vscode/vsce publish --allow-missing-repository
   ```
   - 이 명령어 하나로 코드 컴파일, 패키징, 마켓플레이스 최종 업로드까지 원스톱으로 처리됩니다.

### 방법 2. 웹페이지를 통한 수동 업로드
1. 로컬에서 패키징한 `callgraph-extension-0.1.0.vsix` 파일을 준비합니다.
2. **[VS Code Marketplace 관리 페이지](https://marketplace.visualstudio.com/manage)**에 접속합니다.
3. 본인의 Publisher 계정을 선택한 후, **New Extension** ➔ **Visual Studio Code**를 클릭합니다.
4. 준비해 둔 `.vsix` 파일을 드래그 앤 드롭으로 업로드합니다.

---

## 4. 유용한 팁 및 주의사항
- **버전 관리**: 업데이트하여 재배포 시에는 `package.json`의 `"version"` 값(예: `0.1.0` ➔ `0.1.1`)을 올려주어야 중복 버전 에러가 나지 않습니다.
- **아이콘 등록**: 마켓플레이스 검색 결과에 예쁜 썸네일을 띄우고 싶다면, `package.json`에 `"icon": "media/icon.png"`와 같이 아이콘 이미지 경로를 지정한 후 배포해 보세요.
