<script lang="ts">
  let { id }: { id?: string } = $props();
</script>

<p {id} class="auth-instruction">
  macOS Keychain protects the device key that keeps you signed in. If a system
  prompt asks for access to a “WebCrypto Master Key,” finish it in macOS to
  continue.
</p>
