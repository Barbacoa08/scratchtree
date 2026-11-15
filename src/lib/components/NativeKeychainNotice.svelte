<script lang="ts">
  let { id }: { id?: string } = $props();
</script>

<p {id} class="auth-instruction">
  Scratchtree uses a protected key on this Mac to keep you signed in. macOS may
  ask permission to use that key. This permission applies to Scratchtree’s
  sign-in key, not your entire Keychain.
</p>
