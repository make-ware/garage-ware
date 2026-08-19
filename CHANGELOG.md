# Changelog

## [1.10.0](https://github.com/make-ware/garage-ware/compare/v1.9.0...v1.10.0) (2026-08-19)


### Features

* add feature flags for deployments ([b4cb7fa](https://github.com/make-ware/garage-ware/commit/b4cb7fa618e378103548ac4710028826b9f9ef08))
* add node and key claim mechanism ([60961a6](https://github.com/make-ware/garage-ware/commit/60961a695a1c87e1bc2d569e264124ebf2896c5c))
* cluster events ([93cc768](https://github.com/make-ware/garage-ware/commit/93cc76866662ed6b273acdfd72e470f0e765c5a4))

## [1.9.0](https://github.com/make-ware/garage-ware/compare/v1.8.3...v1.9.0) (2026-08-16)


### Features

* onboarding flow and repair section ([5f58236](https://github.com/make-ware/garage-ware/commit/5f582360b530a60cf49cdeda732634bde9619e6f))


### Bug Fixes

* add cost calculation ([0a62095](https://github.com/make-ware/garage-ware/commit/0a620959329c62acf1404b26a53418f67ab8567d))
* ledger math ([92cbaeb](https://github.com/make-ware/garage-ware/commit/92cbaeb2bfffa384f8c0e54febbfac7ff4681b39))

## [1.8.3](https://github.com/make-ware/garage-ware/compare/v1.8.2...v1.8.3) (2026-08-13)


### Bug Fixes

* metrics filter and layout ([2b84a32](https://github.com/make-ware/garage-ware/commit/2b84a3285199ce0685d8b7ae22bdeb7b5656f3d3))

## [1.8.2](https://github.com/make-ware/garage-ware/compare/v1.8.1...v1.8.2) (2026-08-13)


### Bug Fixes

* add cluster events collection ([c5c54b9](https://github.com/make-ware/garage-ware/commit/c5c54b9803d4b62c248ed0cd9b495b6f73961717))
* add timeline to cluster page ([f9591bb](https://github.com/make-ware/garage-ware/commit/f9591bb49d9910df913a3fbbabf98e83effd69f3))

## [1.8.1](https://github.com/make-ware/garage-ware/compare/v1.8.0...v1.8.1) (2026-08-12)


### Bug Fixes

* docker build update ([8bb2f4f](https://github.com/make-ware/garage-ware/commit/8bb2f4fea7bffcac31c8144ad9a631cc95948377))
* scrape the node partitions and expected size ([763d39b](https://github.com/make-ware/garage-ware/commit/763d39b7e9be587b673ec35d097df5894dfaae60))

## [1.8.0](https://github.com/make-ware/garage-ware/compare/v1.7.0...v1.8.0) (2026-08-12)


### Features

* identify nodes by name or one truncated node id ([1638607](https://github.com/make-ware/garage-ware/commit/1638607b76a9a744f3df6ba41bf58229ec06a994))
* identify nodes by name or one truncated node id ([efa482d](https://github.com/make-ware/garage-ware/commit/efa482da7c012ae243a3524aa94b835d37358e9e))


### Bug Fixes

* resolve docker build failure from pocketbase path rename ([b0200be](https://github.com/make-ware/garage-ware/commit/b0200be10a6ff6cc152643a2b60d226a396ad91b))

## [1.7.0](https://github.com/make-ware/garage-ware/compare/v1.6.0...v1.7.0) (2026-08-09)


### Features

* add cluster layout ([e492f11](https://github.com/make-ware/garage-ware/commit/e492f115f4737c47d75cf468f0a197c3aaf127fb))
* add garage api cache ([900c86b](https://github.com/make-ware/garage-ware/commit/900c86b3df0a91ff9dd9bdf3ebf4b4d1a41daa0a))


### Bug Fixes

* add invite system ([a8e6a58](https://github.com/make-ware/garage-ware/commit/a8e6a58394c82c63888b2fe829dbd67564b66437))
* add metrics page ([0f5b9d3](https://github.com/make-ware/garage-ware/commit/0f5b9d3b4298c46effa0f8705d455bbb7c4d036d))
* broken dep ([3ed8284](https://github.com/make-ware/garage-ware/commit/3ed82840f5fe91d82f18ffb88e4b3e83f6b28e76))
* bump deps ([a7a5c3f](https://github.com/make-ware/garage-ware/commit/a7a5c3f607c0ee2944aec27d12b9ad30495f6cab))
* deps ([1dc0bee](https://github.com/make-ware/garage-ware/commit/1dc0bee8e7bb1d94f5ee6d248e9431229018de72))

## [1.6.0](https://github.com/make-ware/garage-ware/compare/v1.5.1...v1.6.0) (2026-08-08)


### Features

* **dashboard:** reuse admin bucket card, metrics, and sortable table ([1f2e905](https://github.com/make-ware/garage-ware/commit/1f2e90522027aab3f378061a9468984474a86c32))
* show app version next to the app name in the nav bar ([a870ffa](https://github.com/make-ware/garage-ware/commit/a870ffad7fcf090c95ff7a16bfa078699d76462a))


### Bug Fixes

* improve homepage ([9f9d2fe](https://github.com/make-ware/garage-ware/commit/9f9d2fedf0f19bcc6973842e946a526e0702e315))

## [1.5.1](https://github.com/make-ware/garage-ware/compare/v1.5.0...v1.5.1) (2026-08-08)


### Bug Fixes

* **admin:** give quota drift its own page, grouped by user ([d0d32d4](https://github.com/make-ware/garage-ware/commit/d0d32d4bf1054bdf93085e2774c20ed30fe83b55))
* **admin:** slim the buckets table and make it sortable ([9cccaba](https://github.com/make-ware/garage-ware/commit/9cccaba186dc0c28d92a3bede43f4881b108f093))
* **buckets:** apply the object override on write and reconcile ([4e0c3da](https://github.com/make-ware/garage-ware/commit/4e0c3daddf0e37ed6cff76a974c79194091db37e))
* **buckets:** let an object quota be set, not only derived ([c7dc63a](https://github.com/make-ware/garage-ware/commit/c7dc63a60d4fdc2944fb4ea4329ced977c3c6733))

## [1.5.0](https://github.com/make-ware/garage-ware/compare/v1.4.13...v1.5.0) (2026-08-08)


### Features

* Add storage ledger audit trail and balance roll-ups ([b084435](https://github.com/make-ware/garage-ware/commit/b08443561fb0ea056a5bcfe7fd0db1742596b21d))
* **claims:** add claim audit trail and share the storage accounting ([50493e4](https://github.com/make-ware/garage-ware/commit/50493e4426361108e9ed602a1e21c40a706e25dd))
* **claims:** add claim audit trail and share the storage accounting ([2fabfd5](https://github.com/make-ware/garage-ware/commit/2fabfd5da1282e2ddf4a39a9430e05edab50dbe6))
* **storage:** materialize balance roll-ups and audit bucket quota drift ([87e48c8](https://github.com/make-ware/garage-ware/commit/87e48c83ada953ef91007a6cc5eec2022ec2b502))


### Bug Fixes

* **admin:** read the bucket owner's grant instead of a truncated user page ([8a094b3](https://github.com/make-ware/garage-ware/commit/8a094b341fa0dc4781d372b58fb0dd5cbc02764e))
* **balances:** stop rebuild drift from cancelling itself out ([6dd2247](https://github.com/make-ware/garage-ware/commit/6dd22477447c80815ca356811df69741d3ee185a))
* **buckets:** only count a reconcile as synced when it wrote something ([f6d9182](https://github.com/make-ware/garage-ware/commit/f6d9182b21fb111fa5046633a5305a74a00a8002))
* **hooks:** commit audit and balance writes with the record they describe ([8f62faa](https://github.com/make-ware/garage-ware/commit/8f62faae517c4d739ec3a1289b42168fe1058815))
* **storage:** page getUserBalances to exhaustion ([af52479](https://github.com/make-ware/garage-ware/commit/af5247957d7ebc6d4b5859657f3dcdefc56603f7))

## [1.4.13](https://github.com/make-ware/garage-ware/compare/v1.4.12...v1.4.13) (2026-07-20)


### Bug Fixes

* add maxObjects to admin pages ([015ddf1](https://github.com/make-ware/garage-ware/commit/015ddf1c3025ed72aa12ec6f250a5a93455d6bd7))
* add password reset flow ([fa98fab](https://github.com/make-ware/garage-ware/commit/fa98fabd4196ebc7b3749fc722e3fd349c929a39))

## [1.4.12](https://github.com/make-ware/garage-ware/compare/v1.4.11...v1.4.12) (2026-06-23)


### Bug Fixes

* add max object to database ([833aa18](https://github.com/make-ware/garage-ware/commit/833aa183590c04bf7ec2d9e9451544a11475f67a))

## [1.4.11](https://github.com/make-ware/garage-ware/compare/v1.4.10...v1.4.11) (2026-06-22)


### Bug Fixes

* add bucket links on dash ([a56dad5](https://github.com/make-ware/garage-ware/commit/a56dad59ff88d8b6ab899b81f397073e4eb92d98))
* add max object quota env ([2e830ae](https://github.com/make-ware/garage-ware/commit/2e830aeb8ff910d79979d0eef247f5c2ac76150c))

## [1.4.10](https://github.com/make-ware/garage-ware/compare/v1.4.9...v1.4.10) (2026-06-09)


### Bug Fixes

* restore both s3 endpoints ([a97ecd8](https://github.com/make-ware/garage-ware/commit/a97ecd8e84821e12b488ff086ae7822e71d00e3e))

## [1.4.9](https://github.com/make-ware/garage-ware/compare/v1.4.8...v1.4.9) (2026-06-09)


### Bug Fixes

* add public s3 endpoint ([cff128f](https://github.com/make-ware/garage-ware/commit/cff128f731705175dfcb8c03f12c20f2fa83bacb))

## [1.4.8](https://github.com/make-ware/garage-ware/compare/v1.4.7...v1.4.8) (2026-06-09)


### Bug Fixes

* update table layout ([16464d8](https://github.com/make-ware/garage-ware/commit/16464d83df52ab4f49354a576a1322bc89dd2287))

## [1.4.7](https://github.com/make-ware/garage-ware/compare/v1.4.6...v1.4.7) (2026-06-08)


### Bug Fixes

* format ([a0d5621](https://github.com/make-ware/garage-ware/commit/a0d5621f18c8959a4bd39a7cd8ac2dad77682cd9))
* move garage s3 region to api config ([910b858](https://github.com/make-ware/garage-ware/commit/910b8582f005a1abfde1d22aae49fedaf5225c06))

## [1.4.6](https://github.com/make-ware/garage-ware/compare/v1.4.5...v1.4.6) (2026-06-08)


### Bug Fixes

* add args ([41c7cc3](https://github.com/make-ware/garage-ware/commit/41c7cc33b89c3491c25a9f0fcb415e6b4997520f))
* update endpoints to be dynamic ([fdf9e5e](https://github.com/make-ware/garage-ware/commit/fdf9e5e8e46f1fcfd477b0657fa2e8d8ef06c528))

## [1.4.5](https://github.com/make-ware/garage-ware/compare/v1.4.4...v1.4.5) (2026-06-08)


### Bug Fixes

* add s3 file viewer ([4debba4](https://github.com/make-ware/garage-ware/commit/4debba4462f8f8db5432bee0ecb72bee87734f19))
* format issues ([b06296f](https://github.com/make-ware/garage-ware/commit/b06296f0fc5a7d03eaef4e2b84dddba5289caf88))
* increase percentage ([33292f9](https://github.com/make-ware/garage-ware/commit/33292f97beffebb03a8a57ec3e349b8ecb1dd3ad))
* update header ([9c97eca](https://github.com/make-ware/garage-ware/commit/9c97eca58f40761f341bd70f56b42b16fce98b82))

## [1.4.4](https://github.com/make-ware/garage-ware/compare/v1.4.3...v1.4.4) (2026-05-11)


### Bug Fixes

* improve OTP flow ([5c74f23](https://github.com/make-ware/garage-ware/commit/5c74f233f822b94517304c5be05663277235668d))

## [1.4.3](https://github.com/make-ware/garage-ware/compare/v1.4.2...v1.4.3) (2026-05-11)


### Bug Fixes

* issue pb cron job scope ([bea63c6](https://github.com/make-ware/garage-ware/commit/bea63c6068bae5a5170a42ab9bf5f934febc837c))

## [1.4.2](https://github.com/make-ware/garage-ware/compare/v1.4.1...v1.4.2) (2026-05-11)


### Bug Fixes

* update email format ([dcb4898](https://github.com/make-ware/garage-ware/commit/dcb4898025db86420acadf30982d726a8a13627c))

## [1.4.1](https://github.com/make-ware/garage-ware/compare/v1.4.0...v1.4.1) (2026-05-10)


### Bug Fixes

* add ownership guard ([fa9d39b](https://github.com/make-ware/garage-ware/commit/fa9d39be1e0a8afef8ae1755c5993c9e64d05b7d))

## [1.4.0](https://github.com/make-ware/garage-ware/compare/v1.3.3...v1.4.0) (2026-05-09)


### Features

* add email reminders ([b2a0b9e](https://github.com/make-ware/garage-ware/commit/b2a0b9e24274b39eaf1abd0114c9b72103c6d313))

## [1.3.3](https://github.com/make-ware/garage-ware/compare/v1.3.2...v1.3.3) (2026-05-08)


### Bug Fixes

* update display unit (TiB to TB) ([e658245](https://github.com/make-ware/garage-ware/commit/e658245337ee719e4caa9bff7537987425f7ea58))

## [1.3.2](https://github.com/make-ware/garage-ware/compare/v1.3.1...v1.3.2) (2026-05-07)


### Bug Fixes

* add connection page ([9b6f703](https://github.com/make-ware/garage-ware/commit/9b6f7036c4dd99557b9737aeed6cd8ea80b500de))

## [1.3.1](https://github.com/make-ware/garage-ware/compare/v1.3.0...v1.3.1) (2026-05-06)


### Bug Fixes

* add storage sync ([8c8c7dc](https://github.com/make-ware/garage-ware/commit/8c8c7dc604c6a04c42311502a109e663e9668510))

## [1.3.0](https://github.com/make-ware/garage-ware/compare/v1.2.0...v1.3.0) (2026-05-06)


### Features

* Add notification level ([0a57ee3](https://github.com/make-ware/garage-ware/commit/0a57ee3ea378af342072ee2d12ca9456bc15bf1e))
* add user storage transfers ([b195c94](https://github.com/make-ware/garage-ware/commit/b195c948d29bd1f0c0e82860db69423a54af6ec9))


### Bug Fixes

* streamine docker logs ([a5dd0ea](https://github.com/make-ware/garage-ware/commit/a5dd0ea06a3131b9b0917b411d3613b81529eafe))
* update admin console ([7051168](https://github.com/make-ware/garage-ware/commit/705116845a3731c3dff7b240f9515a2263b0c465))

## [1.2.0](https://github.com/make-ware/garage-ware/compare/v1.1.0...v1.2.0) (2026-05-06)


### Features

* add storage claims ([1becb04](https://github.com/make-ware/garage-ware/commit/1becb0419dc704a32db58fb7c3a68f97d89bb162))
* mvp ([a0b2a1d](https://github.com/make-ware/garage-ware/commit/a0b2a1d92202a31c167a39ac7893a575c09d63b1))


### Bug Fixes

* build docker container ([483ee2e](https://github.com/make-ware/garage-ware/commit/483ee2e23e6fd58bf73f27871c7c064d85e4cbaa))
* docker build tagging ([db2b1f0](https://github.com/make-ware/garage-ware/commit/db2b1f07beadb212895c5b68841bcf4ff27d6e2c))
* improve unit conv ([e4838b7](https://github.com/make-ware/garage-ware/commit/e4838b73473ee667e5aba1ccfbfb342d85070961))
* move bucket quota entry to tb ([148aecc](https://github.com/make-ware/garage-ware/commit/148aecc23407ce0764d60a48b8f60b490a12233d))
* move next api calls to next-api ([4435cbc](https://github.com/make-ware/garage-ware/commit/4435cbcc993ee977f612d0dd0bbb20ec39dec84f))
* supervisor issue ([c62cef5](https://github.com/make-ware/garage-ware/commit/c62cef58ff8504f24a6b46421117b87286bbde13))
* update release please ([78cefb0](https://github.com/make-ware/garage-ware/commit/78cefb073c7d69d9cd977b2c8db0a8e402eb06a6))
* update release please config ([33c3427](https://github.com/make-ware/garage-ware/commit/33c34278fdcb924b651f6055ec7c669a7584e32e))

## [1.1.0](https://github.com/make-ware/garage-ware/compare/garage-ware-v1.0.0...garage-ware-v1.1.0) (2026-05-06)


### Features

* add storage claims ([1becb04](https://github.com/make-ware/garage-ware/commit/1becb0419dc704a32db58fb7c3a68f97d89bb162))
* mvp ([a0b2a1d](https://github.com/make-ware/garage-ware/commit/a0b2a1d92202a31c167a39ac7893a575c09d63b1))


### Bug Fixes

* build docker container ([483ee2e](https://github.com/make-ware/garage-ware/commit/483ee2e23e6fd58bf73f27871c7c064d85e4cbaa))
* docker build tagging ([db2b1f0](https://github.com/make-ware/garage-ware/commit/db2b1f07beadb212895c5b68841bcf4ff27d6e2c))
* move bucket quota entry to tb ([148aecc](https://github.com/make-ware/garage-ware/commit/148aecc23407ce0764d60a48b8f60b490a12233d))
* move next api calls to next-api ([4435cbc](https://github.com/make-ware/garage-ware/commit/4435cbcc993ee977f612d0dd0bbb20ec39dec84f))
* supervisor issue ([c62cef5](https://github.com/make-ware/garage-ware/commit/c62cef58ff8504f24a6b46421117b87286bbde13))
* update release please ([78cefb0](https://github.com/make-ware/garage-ware/commit/78cefb073c7d69d9cd977b2c8db0a8e402eb06a6))
* update release please config ([33c3427](https://github.com/make-ware/garage-ware/commit/33c34278fdcb924b651f6055ec7c669a7584e32e))

## 1.0.0 (2026-05-06)


### Features

* add storage claims ([1becb04](https://github.com/make-ware/garage-ware/commit/1becb0419dc704a32db58fb7c3a68f97d89bb162))
* mvp ([a0b2a1d](https://github.com/make-ware/garage-ware/commit/a0b2a1d92202a31c167a39ac7893a575c09d63b1))


### Bug Fixes

* build docker container ([483ee2e](https://github.com/make-ware/garage-ware/commit/483ee2e23e6fd58bf73f27871c7c064d85e4cbaa))
* move bucket quota entry to tb ([148aecc](https://github.com/make-ware/garage-ware/commit/148aecc23407ce0764d60a48b8f60b490a12233d))
* update release please config ([33c3427](https://github.com/make-ware/garage-ware/commit/33c34278fdcb924b651f6055ec7c669a7584e32e))
