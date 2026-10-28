import { Component, type ReactNode } from 'react';

type Props = { children: ReactNode; onError?: (error: unknown) => void };

/**
 * Keeps a failed 3D load (no WebGL, the chunk or the model not reachable) from taking the screen down: the 3D part
 * renders nothing and the caller keeps showing the picture. React has no hook for this, hence the class.
 */
export class ThreeBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn('Chapp 3D unavailable:', error);
    this.props.onError?.(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
