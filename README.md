# CycleNavi（仮）— 設計書・デプロイ手順

自転車ツーリング（ランドナー・自転車キャンプ）向けのルート作成・記録・共有Webアプリです。

| 役割 | 使うもの |
|---|---|
| フロント | GitHub Pages（`index.html` / `app.js`）、Tailwind CDN、Leaflet + OSM、Chart.js、exifr |
| バックエンド | Google Apps Script（`Code.gs`）Webアプリ |
| DB | Googleスプレッドシート（6シート） |
| ファイル保管 | Googleドライブ（写真・GPX・ルートJSON） |
| 経路・標高 | OpenRouteService（GAS経由でAPIキーを隠す） |
| スポット | Overpass API（ブラウザから直接）＋会員登録スポット |
| AI | Gemini API（写真の場所推定・スポット判定・ツーリング助言） |

---

## 1. スプレッドシート設計書

`setup()` を実行すると、以下のシートとヘッダーが自動で作られます（手で作る必要はありません）。

### Users（会員）
| 列 | 内容 |
|---|---|
| userId | `U`＋ランダムID |
| email | 小文字に正規化したメールアドレス（一意） |
| nickname | 公開される名前（一意・20文字まで） |
| passwordHash | SHA-256（salt＋パスワード＋pepper） |
| salt | 会員ごとのランダム値 |
| status | `仮登録` / `本登録` / `停止`（手動で「停止」にするとログイン不可） |
| mustChange | TRUE のあいだは本パスワード設定画面へ強制移動 |
| failCount | 連続ログイン失敗回数（5回で15分ロック） |
| lockedUntil | ロック解除日時 |
| createdAt / lastLoginAt | 登録日時 / 最終ログイン日時 |

### Sessions（ログイン状態）
| 列 | 内容 |
|---|---|
| token | ブラウザの LocalStorage に保存される認証トークン |
| userId | 会員ID |
| expiresAt | 有効期限（30日） |
| createdAt | 発行日時 |

### Routes（ルート）
| 列 | 内容 |
|---|---|
| routeId | `R`＋ランダムID |
| userId / nickname | 作成者 |
| title / description | タイトル / 説明 |
| visibility | `private`（既定） / `public` |
| profile | cycling-regular / cycling-road / cycling-mountain / cycling-electric |
| condition | flat（平坦重視）/ quiet（裏道優先）/ shortest（最短） |
| source | ors / gpx / record / photos / saved |
| distanceKm / ascentM / descentM / maxEleM | 距離・獲得標高・下り・最高地点 |
| startLat / startLng | 出発地点 |
| dataFileId | ドライブ `routes/` のJSON（座標・経由地・スポット・写真） |
| gpxFileId | ドライブ `gpx/` のGPXファイル |
| thumbFileId | 一覧に表示する写真 |
| likeCount / commentCount | 集計値（操作のたびに再計算） |
| createdAt / updatedAt | 作成・更新日時 |

座標はセルの文字数上限（5万字）を超えるため、シートではなくドライブのJSONに保存しています。

### Comments（コメント）
| 列 | 内容 |
|---|---|
| commentId / routeId | コメントID / 対象ルート |
| userId / nickname | 投稿者 |
| body | 本文（500文字まで） |
| createdAt / updatedAt | 投稿・編集日時 |

権限：編集は投稿者本人のみ。削除は投稿者本人またはルート作成者。

### Likes（いいね）
| 列 | 内容 |
|---|---|
| likeId / routeId / userId / createdAt | routeId＋userId の組み合わせは1件まで（押すたびに付く・外れる） |

### Spots（会員登録スポット）
| 列 | 内容 |
|---|---|
| spotId / userId / nickname | スポットIDと登録者 |
| category | camp / michinoeki / onsen / supply / view / other |
| name / note | 名前 / メモ（AIの説明） |
| lat / lng | 位置 |
| photoFileId | ドライブの写真 |
| source | exif / ai / manual |
| visibility | private（既定）/ public |
| createdAt | 登録日時 |

### ドライブのフォルダ構成（自動作成）
```
CycleNavi_Data/
 ├ photos/   アップロード写真（リンクを知っている人が閲覧可）
 ├ gpx/      保存したルートのGPX
 └ routes/   ルート本体のJSON
```

---

## 2. デプロイ・連携手順

### ① APIキーを用意する
1. **Gemini APIキー**：Google AI Studio（https://aistudio.google.com/）→「Get API key」→ キーを作成。
2. **OpenRouteService APIキー**：https://openrouteservice.org/dev/ でアカウント登録 →「Tokens」でキーを作成（無料枠：経路検索 1日2,000回）。

### ② スプレッドシートとGASを用意する
1. Googleスプレッドシートを新規作成（名前例：`CycleNavi_DB`）。
2. 「拡張機能 → Apps Script」を開き、`コード.gs` の中身をすべて `Code.gs` の内容に置き換えて保存。
3. 左の歯車「プロジェクトの設定」→ 下の「スクリプト プロパティ」に追加：
   | プロパティ | 値 |
   |---|---|
   | `GEMINI_API_KEY` | ①のGeminiキー |
   | `ORS_API_KEY` | ①のORSキー |
   | `APP_URL` | `https://kenken6291.github.io/cycle-navi/`（メール本文に載ります・任意） |
   | `GEMINI_MODEL` | 使いたいモデル名（任意。未設定なら `gemini-flash-latest`） |
4. エディタ上部の関数選択で `setup` を選び「実行」→ 権限を承認（「詳細 → 安全ではないページに移動」→ 許可）。  
   実行ログにドライブフォルダのURLが出れば成功です。  
   ※ `PEPPER` は自動生成されます。**後から変更すると全員のパスワードが使えなくなる**ので触らないでください。

### ③ GASをWebアプリとして公開する
1. 右上「デプロイ → 新しいデプロイ」→ 種類「ウェブアプリ」。
2. 次のユーザーとして実行：**自分**／アクセスできるユーザー：**全員**。
3. 「デプロイ」→ 表示された **ウェブアプリURL（…/exec）** をコピー。

> **コードを直したら必ず**「デプロイ → デプロイを管理 → 鉛筆 → バージョン：新バージョン → デプロイ」。  
> これをしないと、URLは同じでも古いコードのまま動きます。

### ④ フロントを設定してGitHub Pagesへ
1. `app.js` 先頭の `CONFIG.GAS_URL` を③のURLに書き換える。
2. GitHubに新しいリポジトリ（例：`cycle-navi`）を作り、`index.html` と `app.js` を置いてコミット。
3. リポジトリの「Settings → Pages」→ Branch：`main` / `(root)` → Save。
4. 数分後 `https://kenken6291.github.io/cycle-navi/` で開けます。

### ⑤ 動作確認の順番
1. 新規登録 → メールの仮パスワードでログイン → 本パスワード設定画面が出る。
2. 地図を2か所タップ →「ルートを引く」→ 下に距離・獲得標高・標高グラフが出る。
3. 「スポット」タブ →「スポットを探す」→ ルート沿いにアイコンが出る。
4. 「写真」タブ → 位置情報付き写真を選ぶ → ドライブの `photos/` に保存される →「撮影順に経由地を作る」。
5. 「保存する」→ 公開にして、「みんなのルート」でいいね・コメント。
6. 「GPXで書き出す」→ ダウンロードしたファイルを「記録・GPX」タブで読み込めるか確認。

---

## 3. 仕様メモ・制限

- **経路条件の仕組み**：ORSには「平坦」「裏道」専用モードがないため、出発地と目的地だけのときは代替ルートを最大3本取り、平坦重視＝獲得標高最小、裏道優先＝国道・県道（ORSのwaytype「state road」）の割合最小、を選びます。経由地を入れると候補は1本になります。代替ルートは概ね100km以内でのみ有効（超えると自動で1本に切り替え）。
- **Overpass API** は無料の共用サーバーのため、混雑時は数十秒かかる・失敗することがあります。時間をおいて再実行してください。
- **写真の位置情報**：LINE・SNS経由の写真はGPS情報が消えています。HEICはChromeなどで読めない場合があるのでJPEGで。
- **AIの場所推定**：Geminiが推定した地名をGASの `Maps.newGeocoder()` で座標にし、前後の写真から150km以上離れた同名地は採用しません。確からしさ「低」は必ず地図で確認してください。
- **走行記録**：ブラウザのGPSは画面を消すと止まる端末が多いです。本格的な記録はサイコンやスマホアプリで取り、GPXを読み込む運用がおすすめ。記録途中はLocalStorageに退避しており、ページを開き直すと復元を確認します。
- **写真の公開範囲**：ドライブの写真は「リンクを知っている人が閲覧可」に設定します（サムネイル表示のため）。組織アカウントでこの設定が禁止されていると一覧に写真が出ません。
- **会員の利用停止**：Usersシートの `status` を `停止` にすると、次の操作からログアウト扱いになります。
