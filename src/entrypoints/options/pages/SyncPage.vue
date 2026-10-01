<script setup lang="ts">
import BackupSection from '../sections/BackupSection.vue';
import CredentialSyncSection from '../sections/CredentialSyncSection.vue';
import SyncSection from '../sections/SyncSection.vue';
import WebDavSection from '../sections/WebDavSection.vue';

/**
 * 同步页：三种同步方式可同时启用——浏览器账号（chrome.storage.sync）、WebDAV、手动备份；以及凭据是否随同步上传。
 * 快照编码与合并规则三者一致（core/sync），所以同一份数据经不同方式同步不会冲突。
 */
</script>

<template>
  <SyncSection />
  <WebDavSection />
  <BackupSection />
  <CredentialSyncSection />
</template>
