package android.annotation;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

/**
 * The nullable half of the pair. See NonNull for why these live here.
 *
 * RUNTIME retention on purpose: it lands in RuntimeVisibleAnnotations and
 * RuntimeVisibleParameterAnnotations rather than the Invisible pair, so the
 * fixture exercises both attribute families that state the same fact. A
 * parser that handled only one would pass every test built on one retention.
 */
@Retention(RetentionPolicy.RUNTIME)
public @interface Nullable {}
